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
		setupListRendering: (element: Element, expr: string) => void
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
				} else if (macroName === 'for')
					options.setupListRendering(currentElementNode, expr)
				else if (macroName === 'key') continue
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
