export default function processTemplateMacros(
	element: Element,
	context: CustomElement,
	options: {
		updateTextNode: (node: Text, expr: string, originalContent: string) => void
		setupAttributeBinding: (
			element: Element,
			attrName: string,
			expr: string,
			attrValue: string,
		) => void
		setupArrowFunctionHandler: (
			element: Element,
			eventName: string,
			handlerValue: string,
		) => void
		setupFunctionCallHandler: (
			element: Element,
			eventName: string,
			handlerValue: string,
		) => void
		setupExpressionHandler: (
			element: Element,
			eventName: string,
			handlerValue: string,
		) => void
		stateToElementsMap: Record<string, Set<HTMLElement>>
		textBindings: {
			node: Text
			expr: string
			originalContent: string
		}[]
		availableFuncs: string[]
		stateListeners: Record<string, (newValue: unknown) => void>
		conditionalElements: Map<
			Element,
			{ expr: string; placeholder: Comment; isPresent: boolean }
		>
		evaluateIfCondition: (element: Element, expr: string) => void
		extractStatePathsFromExpression: (expr: string) => string[]
		states: Record<string, unknown>
		triggerFunc: (eventName: string, ...args: unknown[]) => void
	},
) {
	/*
	 * We define that those prefix are available as macros:
	 * - @ means event binding macro, such as @click="handleClick"
	 * - : means dynamic attribute macro, such as :src="imageUrl"
	 * - % means component controlling macro, such as %if="condition", %for="item in items" and %connect="stateName"
	 */

	// Traverse all child nodes, including text nodes
	const walker = document.createTreeWalker(
		element,
		NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
		null,
	)

	// Store nodes and expressions that need to be updated
	const textBindings: Array<{
		node: Text
		expr: string
		originalContent: string
	}> = []
	const ifDirectivesToProcess: Array<{ element: Element; expr: string }> = []

	// Traverse the DOM tree
	let currentNode: Node | null
	let flag = true
	while (flag) {
		currentNode = walker.nextNode()
		if (!currentNode) {
			flag = false
			break
		}

		// Handle text nodes
		if (currentNode.nodeType === Node.TEXT_NODE) {
			const textContent = currentNode.textContent || ''
			const textNode = currentNode as Text

			// Check if it contains Handlebars expressions {{ xxx }}
			if (textContent.includes('{{')) {
				// Save the original content, including expressions
				const originalContent = textContent

				// Record nodes and expressions that need to be updated
				const matches = textContent.match(/\{\{\s*([^}]+)\s*\}\}/g)
				if (matches) {
					for (const match of matches) {
						// Extract the expression content, removing {{ }} and spaces
						const expr = match.replace(/\{\{\s*|\s*\}\}/g, '').trim()

						// Store the node, expression, and original content for later updates
						textBindings.push({ node: textNode, expr, originalContent })

						// Set the initial value
						options.updateTextNode(textNode, expr, originalContent)

						// Add dependency relationship for this state path
						if (!options.stateToElementsMap[expr])
							options.stateToElementsMap[expr] = new Set()

						options.stateToElementsMap[expr].add(
							textNode as unknown as HTMLElement,
						)
					}
				}
			}
		}

		// Handle element nodes (can extend to handle attribute bindings, etc.)
		else if (currentNode.nodeType === Node.ELEMENT_NODE) {
			const currentElementNode = currentNode as Element // Renamed to avoid conflict with outer 'element'

			// Traverse all macro attributes

			// Detect :attr="" bindings, such as :src="imageUrl"
			for (const attr of Array.from(currentElementNode.attributes)) {
				if (attr.name.startsWith(':')) {
					const attrName = attr.name.substring(1) // Remove ':'
					const expr = attr.value.trim()

					// Remove the attribute, as it is not a standard HTML attribute
					currentElementNode.removeAttribute(attr.name)

					// Set up attribute binding
					options.setupAttributeBinding(
						currentElementNode,
						attrName,
						expr,
						attr.value,
					)
				}
			}

			// Process @event bindings, such as @click="handleClick"
			const eventBindings = Array.from(currentElementNode.attributes).filter(
				(attr) => attr.name.startsWith('@'),
			)
			// eventBindings.forEach((attr) => {
			for (const attr of eventBindings) {
				const eventName = attr.name.substring(1) // Remove '@'
				const handlerValue = attr.value.trim()

				// Remove the attribute, as it is not a standard HTML attribute
				currentElementNode.removeAttribute(attr.name)

				// Handle different types of event handlers
				if (handlerValue.includes('=>')) {
					// Handle arrow function: @click="e => setState('count', count + 1)"
					options.setupArrowFunctionHandler(
						currentElementNode,
						eventName,
						handlerValue,
					)
				} else if (handlerValue.includes('(') && handlerValue.includes(')')) {
					// Handle function call: @click="increment(5)"
					options.setupFunctionCallHandler(
						currentElementNode,
						eventName,
						handlerValue,
					)
				} else if (
					options.availableFuncs.includes(handlerValue) &&
					typeof (context as unknown as Record<string, unknown>)[
						handlerValue
					] === 'function'
				) {
					// Handle method reference: @click="handleClick"
					currentElementNode.addEventListener(
						eventName,
						(
							context as unknown as Record<string, (...args: unknown[]) => void>
						)[handlerValue].bind(context),
					)
				} else {
					// Handle simple expression: @click="count++" or @input="name = $event.target.value"
					options.setupExpressionHandler(
						currentElementNode,
						eventName,
						handlerValue,
					)
				}
			}

			// Process %-started macros, such as %connect="stateName", %if="condition", %for="item in items"
			const macroBindings = Array.from(currentElementNode.attributes).filter(
				(attr) => attr.name.startsWith('%'),
			)

			// macroBindings.forEach((attr) => {
			for (const attr of macroBindings) {
				const macroName = attr.name.substring(1) // Remove '%'
				const expr = attr.value.trim()

				// Remove the attribute, as it is not a standard HTML attribute
				currentElementNode.removeAttribute(attr.name)

				// Handle different types of macros
				if (macroName === 'connect')
					// Handle state connection: %connect="stateName"
					setupTwoWayBinding(currentElementNode, expr, {
						getNestedState: context.getState.bind(context),
						setState: context.setState.bind(context),
						statesListeners: options.stateListeners,
					})
				else if (macroName === 'if') {
					ifDirectivesToProcess.push({ element: currentElementNode, expr })
				} else if (macroName === 'for') {
					const listContext: ListRenderingContext = {
						states: options.states,
						stateToElementsMap: options.stateToElementsMap,
						statesListeners: options.stateListeners,
						setState: context.setState.bind(context),
						getState: context.getState.bind(context),
						triggerFunc: options.triggerFunc.bind(context),
					}
					setupListRendering(currentElementNode, expr, listContext)
				} else if (macroName === 'key') continue
				else console.warn(`Unknown macro: %${macroName}`)
			}
		}
	}

	// Save text binding relationships for updates
	options.textBindings = textBindings

	// Process all collected %if directives after the main traversal
	for (const { element: ifElement, expr } of ifDirectivesToProcess) {
		setupConditionRendering(ifElement, expr, {
			conditionalElements: options.conditionalElements,
			evaluateIfCondition: options.evaluateIfCondition.bind(context),
			extractStatePathsFromExpression: options.extractStatePathsFromExpression,
			stateToElementsMap: options.stateToElementsMap,
		})
	}
}

// Handle two-way data binding (%connect macro)
function setupTwoWayBinding(
	element: Element,
	expr: string,
	ops: {
		getNestedState: (path: string) => unknown
		setState: (path: string, value: unknown) => void
		statesListeners: Record<string, (newValue: unknown) => void>
	},
) {
	// Get the initial value
	const value = ops.getNestedState(expr)

	// Set the initial value
	if (value !== undefined)
		element.setAttribute('data-laterano-connect', String(value))
	else
		console.error(
			`State \`${expr}\` not found in the component state. Although Laterano will try to work with it, it may has potentially unexpected behavior.`,
		)

	// Add event listener for input events
	element.addEventListener('input', (event: Event) => {
		const target = event.target as HTMLInputElement
		const newValue = target.value

		// Update the state
		ops.setState(expr, newValue)
	})

	// Add event listener for state changes
	ops.statesListeners[expr] = (newValue: unknown) => {
		if (element instanceof HTMLInputElement) element.value = newValue as string
		else element.setAttribute('data-laterano-connect', String(newValue))
	}
}

// Handle condition rendering (%if macro)
function setupConditionRendering(
	element: Element,
	expr: string,
	ops: {
		conditionalElements: Map<
			Element,
			{ expr: string; placeholder: Comment; isPresent: boolean }
		>
		evaluateIfCondition: (element: Element, expr: string) => void
		extractStatePathsFromExpression: (expr: string) => string[]
		stateToElementsMap: Record<string, Set<HTMLElement>>
	},
) {
	const placeholder = document.createComment(` %if: ${expr} `)
	element.parentNode?.insertBefore(placeholder, element)

	ops.conditionalElements.set(element, {
		expr,
		placeholder,
		isPresent: true,
	})

	ops.evaluateIfCondition(element, expr)

	const statePaths = ops.extractStatePathsFromExpression(expr)
	for (const path of statePaths) {
		if (!ops.stateToElementsMap[path]) ops.stateToElementsMap[path] = new Set()
		ops.stateToElementsMap[path].add(element as HTMLElement)
	}
}

// Evaluate expressions using the item context
function evaluateExpressionWithItemContext(
	expression: string,
	itemContext: Record<string, unknown>,
	context: ListRenderingContext,
	index?: number,
	itemVar?: string,
	indexVar?: string,
): unknown {
	try {
		// Check if the expression directly references the item variable
		if (itemVar && expression === itemVar) {
			return itemContext[itemVar]
		}

		// Check if the expression is an item property path
		if (itemVar && expression.startsWith(`${itemVar}.`)) {
			const propertyPath = expression.substring(itemVar.length + 1)
			const parts = propertyPath.split('.')
			let value = itemContext[itemVar]

			for (const part of parts) {
				if (value === undefined || value === null) return undefined
				value = (value as { [key: string]: unknown })[part]
			}

			return value
		}

		// Check if the expression directly references the index variable
		if (indexVar && expression === indexVar) {
			return index
		}

		// Create a merged context (component state + item context)
		const mergedContext = { ...context.states, ...itemContext }

		// Create a function to evaluate the expression
		const contextKeys = Object.keys(mergedContext)
		const contextValues = Object.values(mergedContext)

		// Use the with statement to allow the expression to access all properties in the context
		const func = new Function(...contextKeys, `return ${expression}`)
		return func(...contextValues)
	} catch (error) {
		console.error(
			`Error evaluating expression with item context: ${expression}`,
			error,
		)
		return undefined
	}
}

// Set up nested list rendering
function setupNestedListRendering(
	element: Element,
	expr: string,
	parentItemContext: Record<string, unknown>,
	context: ListRenderingContext,
) {
	// Parse the expression (e.g., "subItem in item.subItems")
	const match = expr.match(/(?:\(([^,]+),\s*([^)]+)\)|([^,\s]+))\s+in\s+(.+)/)
	if (!match) {
		console.error(`Invalid nested %for expression: ${expr}`)
		return
	}

	// Extract the item variable name, index variable name (optional), and collection expression
	const itemVar = match[3] || match[1]
	const indexVar = match[2] || null
	const collectionExpr = match[4].trim()

	// Evaluate the collection expression, using the parent item context
	const collection = evaluateExpressionWithItemContext(
		collectionExpr,
		parentItemContext,
		context,
	)

	if (!collection || !Array.isArray(collection)) {
		console.warn(
			`Nested collection "${collectionExpr}" is not an array or does not exist`,
		)
		return
	}

	// Create a placeholder comment
	const placeholder = document.createComment(` %for: ${expr} `)
	element.parentNode?.insertBefore(placeholder, element)

	// Remove the original template element from the DOM
	const template = element.cloneNode(true) as Element
	element.parentNode?.removeChild(element)

	// Create an element for each item
	collection.forEach((item, index) => {
		const itemElement = template.cloneNode(true) as Element

		// Create a nested item context, merging the parent context
		const nestedItemContext = {
			...parentItemContext,
			[itemVar]: item,
		}

		if (indexVar) {
			nestedItemContext[indexVar] = index
		}

		// Recursively process this item and its children
		processElementWithItemContext(itemElement, nestedItemContext, context)

		// Insert the item element into the DOM
		placeholder.parentNode?.insertBefore(itemElement, placeholder.nextSibling)
	})
}

// Recursively process the element and its children, applying the item context
function processElementWithItemContext(
	element: Element,
	itemContext: Record<string, unknown>,
	context: ListRenderingContext,
) {
	// Store the item context of the element so that subsequent updates can find it
	;(element as { _itemContext?: Record<string, unknown> })._itemContext =
		itemContext

	// Process bindings in text nodes
	const processTextNodes = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			const textContent = node.textContent || ''
			if (textContent.includes('{{')) {
				const textNode = node as Text
				const updatedContent = textContent.replace(
					/\{\{\s*([^}]+)\s*\}\}/g,
					(match, expr) => {
						const value = evaluateExpressionWithItemContext(
							expr.trim(),
							itemContext,
							context,
						)
						return value !== undefined ? String(value) : ''
					},
				)
				textNode.textContent = updatedContent
			}
		}
	}

	// Process the text nodes of the element itself
	for (const node of Array.from(element.childNodes))
		if (node.nodeType === Node.TEXT_NODE) processTextNodes(node)

	// Process attribute bindings (:attr)
	for (const attr of Array.from(element.attributes)) {
		if (attr.name.startsWith(':')) {
			const attrName = attr.name.substring(1)
			const expr = attr.value.trim()
			const value = evaluateExpressionWithItemContext(
				expr,
				itemContext,
				context,
			)

			if (value !== undefined) element.setAttribute(attrName, String(value))

			// Remove the original binding attribute
			element.removeAttribute(attr.name)
		}
	}

	// Process event bindings (@event)
	for (const attr of Array.from(element.attributes)) {
		if (attr.name.startsWith('@')) {
			const eventName = attr.name.substring(1)
			const handlerValue = attr.value.trim()

			// Remove the original binding attribute
			element.removeAttribute(attr.name)

			// Add event listener
			element.addEventListener(eventName, (event: Event) => {
				try {
					// Create a merged context
					const mergedContext = {
						...context.states,
						...itemContext,
						$event: event,
						$el: element,
						setState: context.setState,
						getState: context.getState,
						triggerFunc: (eventName: string, ...args: unknown[]) =>
							context.triggerFunc(eventName, ...args),
					}

					// Execute the expression
					const fnStr = `with(this) { ${handlerValue} }`
					new Function(fnStr).call(mergedContext)
				} catch (err) {
					console.error(
						`Error executing event handler with item context: ${handlerValue}`,
						err,
					)
				}
			})
		}
	}

	// Process conditional rendering (%if)
	let isConditional = false
	let shouldDisplay = true

	for (const attr of Array.from(element.attributes)) {
		if (attr.name === '%if') {
			isConditional = true
			const expr = attr.value.trim()

			// Remove the original binding attribute
			element.removeAttribute(attr.name)

			// Calculate the condition
			const result = evaluateExpressionWithItemContext(
				expr,
				itemContext,
				context,
			)
			shouldDisplay = Boolean(result)

			// Apply the condition
			if (!shouldDisplay) (element as HTMLElement).style.display = 'none'
		}
	}

	// If the condition evaluates to false, skip further processing of this element
	if (isConditional && !shouldDisplay) {
		return
	}

	// Process nested list rendering (%for)
	let hasForDirective = false

	for (const attr of Array.from(element.attributes)) {
		if (attr.name === '%for') {
			hasForDirective = true
			const forExpr = attr.value.trim()

			// Remove the original binding attribute
			element.removeAttribute(attr.name)

			// Set up nested list rendering
			setupNestedListRendering(element, forExpr, itemContext, context)
		}
	}

	// If this element is a list element, skip child element processing
	if (hasForDirective) return

	// Recursively process all child elements
	for (const child of Array.from(element.children))
		processElementWithItemContext(child, itemContext, context)
}

// Handle list rendering (%for macro)
function setupListRendering(
	element: Element,
	expr: string,
	context: ListRenderingContext,
) {
	// Parse the expression (e.g., "item in items" or "(item, index) in items")
	const match = expr.match(/(?:\(([^,]+),\s*([^)]+)\)|([^,\s]+))\s+in\s+(.+)/)
	if (!match) {
		console.error(`Invalid %for expression: ${expr}`)
		return
	}

	// Extract the item variable name, index variable name (optional), and collection expression
	const itemVar = match[3] || match[1]
	const indexVar = match[2] || null
	const collectionExpr = match[4].trim()

	// Create a placeholder comment
	const placeholder = document.createComment(` %for: ${expr} `)
	element.parentNode?.insertBefore(placeholder, element)

	// Remove the original template element from the DOM
	const template = element.cloneNode(true) as Element
	element.parentNode?.removeChild(element)

	// Store current rendered items
	const renderedItems: Array<{
		element: Element
		key: unknown
		data: unknown
		index: number
	}> = []

	// Create a function to update the list when the collection changes
	const updateList = () => {
		const collection = evaluateExpressionWithItemContext(
			collectionExpr,
			{},
			context,
		)
		if (!collection || !Array.isArray(collection)) {
			console.warn(
				`Collection "${collectionExpr}" is not an array or does not exist`,
			)
			return
		}

		const parentNode = placeholder.parentNode
		if (!parentNode) {
			console.error("Placeholder's parentNode is null. Cannot update list.")
			return
		}

		// Detach all currently rendered DOM items
		for (const item of renderedItems)
			if (item.element.parentNode === parentNode)
				parentNode.removeChild(item.element)

		// Get key attribute if available
		const keyAttr = template.getAttribute('%key')
		if (!keyAttr)
			console.warn(
				'%key attribute not found in the template, which is not a recommended practice.',
			)

		// Store a map of existing items by key for reuse
		const existingElementsByKey = new Map()
		for (const item of renderedItems)
			if (item.key !== undefined) existingElementsByKey.set(item.key, item)

		// Clear rendered items
		renderedItems.length = 0

		// document fragment
		const fragment = document.createDocumentFragment()

		// Create or update items in the list
		collection.forEach((item, index) => {
			// Determine the key for this item
			const key = keyAttr
				? evaluateExpressionWithItemContext(
						keyAttr,
						{ [itemVar]: item },
						context,
						index,
						itemVar,
						indexVar ? indexVar : undefined,
					)
				: index

			// Check if we can reuse an existing element
			const existingItem = existingElementsByKey.get(key)
			let itemElement: Element

			if (existingItem) {
				// Reuse existing element
				itemElement = existingItem.element
				existingElementsByKey.delete(key) // Remove from map so we know it's been used
			} else {
				// Create a new element
				itemElement = template.cloneNode(true) as Element
			}

			// Update item data
			renderedItems.push({
				element: itemElement,
				key,
				data: item,
				index,
			})

			// Create item context for this item
			const itemContext = {
				[itemVar]: item,
			}
			if (indexVar) itemContext[indexVar] = index

			// insert %key attribute
			if (keyAttr) {
				const keyValue = evaluateExpressionWithItemContext(
					keyAttr,
					itemContext,
					context,
				)
				itemElement.setAttribute('data-laterano-key', String(keyValue))
			}

			// remove original %key attribute
			itemElement.removeAttribute('%key')

			// Process the element with the item context
			processElementWithItemContext(itemElement, itemContext, context)

			// Insert the element to the document fragment
			fragment.appendChild(itemElement)
		})

		// Insert the document fragment into the DOM
		placeholder.parentNode?.insertBefore(fragment, placeholder.nextSibling)

		// Remove any remaining unused items
		for (const item of existingElementsByKey.values())
			if (item.element.parentNode)
				item.element.parentNode.removeChild(item.element)
	}

	// Initial render
	updateList()

	// Set up state dependency for collection changes
	if (!context.stateToElementsMap[collectionExpr])
		context.stateToElementsMap[collectionExpr] = new Set()

	// Using a unique identifier for this list rendering instance
	const listVirtualElement = document.createElement('div')
	context.stateToElementsMap[collectionExpr].add(
		listVirtualElement as HTMLElement,
	)

	// Add listener for state changes
	context.statesListeners[collectionExpr] = () => {
		updateList()
	}
}
