import { parseTemplate } from './utils/parseTemplate'

interface ComponentOptions {
	tag: string
	template: string
	style?: string
	onMount?: (this: CustomElement) => void
	onUnmount?: () => void
	onAttributeChanged?: (
		attrName: string,
		oldValue: string,
		newValue: string,
	) => void
	states?: Record<string, unknown>
	statesListeners?: { [key: string]: (value: unknown) => void }
	funcs?: { [key: string]: (...args: unknown[]) => void }
}

export default (options: ComponentOptions) => {
	const {
		tag,
		template,
		style,
		onMount,
		onUnmount,
		onAttributeChanged,
		states,
		statesListeners,
		funcs,
	} = options
	const componentRegistry = new Map()
	componentRegistry.set(tag, options)

	class CustomElementImpl extends HTMLElement {
		private _states: Record<string, unknown> = {}
		private _stateToElementsMap: Record<string, Set<HTMLElement>> = {}
		private _currentRenderingElement: HTMLElement | null = null
		private _statesListeners: Record<string, (...args: unknown[]) => void> = {}
		private _textBindings: Array<{
			node: Text
			expr: string
			originalContent: string
		}> = []
		private _attributeBindings: Array<{
			element: Element
			attrName: string
			expr: string
			template: string
		}> = []
		private _conditionalElements: Map<
			Element,
			{
				expr: string
				placeholder: Comment
				isPresent: boolean
			}
		> = new Map()

		constructor() {
			super()

			// initialize dom tree and append to shadow root
			this._initialize()
		}

		private _initState() {
			// copy state from options
			this._states = new Proxy(
				{ ...(states || {}) },
				{
					set: (
						target: Record<string, unknown>,
						keyPath: string,
						value: unknown,
					) => {
						const valueRoute = keyPath.split('.')
						let currentTarget = target
						for (const i in valueRoute) {
							const key = valueRoute[i]
							if (Number.parseInt(i) === valueRoute.length - 1) {
								currentTarget[key] = value
							} else {
								if (!currentTarget[key]) currentTarget[key] = {}
								currentTarget = currentTarget[key] as Record<string, unknown>
							}
						}
						// trigger dom updates
						this._triggerDomUpdates(keyPath)
						if (this._statesListeners[keyPath])
							this._statesListeners[keyPath](value)

						// trigger %if macros
						if (this._conditionalElements.size > 0)
							this._conditionalElements.forEach((info, element) => {
								if (info.expr.includes(keyPath))
									this._evaluateIfCondition(element, info.expr)
							})

						// trigger state update events
						statesListeners?.[keyPath]?.(value)

						return true
					},
					get: (target: Record<string, unknown>, keyPath: string) => {
						// collect state dependencies
						if (this._currentRenderingElement) {
							if (!this._stateToElementsMap[keyPath])
								this._stateToElementsMap[keyPath] = new Set()
							this._stateToElementsMap[keyPath].add(
								this._currentRenderingElement,
							)
						}

						const valueRoute = keyPath.split('.')
						let currentTarget = target
						for (const i in valueRoute) {
							const key = valueRoute[i]
							if (Number.parseInt(i) === valueRoute.length - 1)
								return currentTarget[key]

							if (!currentTarget[key]) currentTarget[key] = {}
							currentTarget = currentTarget[key] as Record<string, unknown>
						}
						return undefined
					},
				},
			)
		}

		private _initialize() {
			// initialize state
			this._initState()

			// initialize shadow dom
			const shadow = this.attachShadow({ mode: 'open' })

			if (style) {
				const styleElement = document.createElement('style')
				styleElement.textContent = style
				this.shadowRoot?.appendChild(styleElement)
			}

			const rootElement = parseTemplate(template)
			shadow.appendChild(rootElement)

			this._processTemplateMacros(rootElement)
		}

		private _triggerDomUpdates(keyPath: string) {
			if (this._stateToElementsMap[keyPath]) {
				const updateQueue = new Set<HTMLElement>()

				for (const element of this._stateToElementsMap[keyPath]) {
					updateQueue.add(element)
				}

				this._scheduleUpdate(updateQueue)
			}

			// Update text bindings that depend on this state
			if (this._textBindings) {
				// this._textBindings.forEach((binding) => {
				for (const binding of this._textBindings)
					if (
						binding.expr === keyPath ||
						binding.expr.startsWith(`${keyPath}.`)
					)
						this._updateTextNode(
							binding.node,
							binding.expr,
							binding.originalContent,
						)
			}

			// Update attribute bindings that depend on this state
			if (this._attributeBindings) {
				for (const binding of this._attributeBindings)
					if (
						binding.expr === keyPath ||
						binding.expr.startsWith(`${keyPath}.`)
					) {
						const value = this._getNestedState(binding.expr)
						if (value !== undefined)
							binding.element.setAttribute(binding.attrName, String(value))
					}
			}
		}

		private _scheduleUpdate(elements: Set<HTMLElement>) {
			requestAnimationFrame(() => {
				for (const element of elements) this._updateElement(element)
			})
		}

		private _updateElement(element: HTMLElement) {
			const renderFunction = (
				element as { _renderFunction?: () => string | Node }
			)._renderFunction
			if (renderFunction) {
				// Set rendering context
				this._currentRenderingElement = element

				// Execute rendering
				const result = renderFunction()

				// Update DOM
				if (typeof result === 'string') element.innerHTML = result
				else if (result instanceof Node) {
					element.innerHTML = ''
					element.appendChild(result)
				}

				// Clear rendering context
				this._currentRenderingElement = null
			}
		}

		private _processTemplateMacros(element: Element) {
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
			const ifDirectivesToProcess: Array<{ element: Element; expr: string }> =
				[]

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
								this._updateTextNode(textNode, expr, originalContent)

								// Add dependency relationship for this state path
								if (!this._stateToElementsMap[expr])
									this._stateToElementsMap[expr] = new Set()

								this._stateToElementsMap[expr].add(
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
							this._setupAttributeBinding(
								currentElementNode,
								attrName,
								expr,
								attr.value,
							)
						}
					}

					// Process @event bindings, such as @click="handleClick"
					const eventBindings = Array.from(
						currentElementNode.attributes,
					).filter((attr) => attr.name.startsWith('@'))
					// eventBindings.forEach((attr) => {
					for (const attr of eventBindings) {
						const eventName = attr.name.substring(1) // Remove '@'
						const handlerValue = attr.value.trim()

						// Remove the attribute, as it is not a standard HTML attribute
						currentElementNode.removeAttribute(attr.name)

						// Handle different types of event handlers
						if (handlerValue.includes('=>')) {
							// Handle arrow function: @click="e => setState('count', count + 1)"
							this._setupArrowFunctionHandler(
								currentElementNode,
								eventName,
								handlerValue,
							)
						} else if (
							handlerValue.includes('(') &&
							handlerValue.includes(')')
						) {
							// Handle function call: @click="increment(5)"
							this._setupFunctionCallHandler(
								currentElementNode,
								eventName,
								handlerValue,
							)
						} else if (
							typeof (this as Record<string, unknown>)[handlerValue] ===
							'function'
						) {
							// Handle method reference: @click="handleClick"
							currentElementNode.addEventListener(
								eventName,
								(
									this as unknown as Record<
										string,
										(...args: unknown[]) => void
									>
								)[handlerValue].bind(this),
							)
						} else {
							// Handle simple expression: @click="count++" or @input="name = $event.target.value"
							this._setupExpressionHandler(
								currentElementNode,
								eventName,
								handlerValue,
							)
						}
					}

					// Process %-started macros, such as %connect="stateName", %if="condition", %for="item in items"
					const macroBindings = Array.from(
						currentElementNode.attributes,
					).filter((attr) => attr.name.startsWith('%'))

					// macroBindings.forEach((attr) => {
					for (const attr of macroBindings) {
						const macroName = attr.name.substring(1) // Remove '%'
						const expr = attr.value.trim()

						// Remove the attribute, as it is not a standard HTML attribute
						currentElementNode.removeAttribute(attr.name)

						// Handle different types of macros
						if (macroName === 'connect')
							// Handle state connection: %connect="stateName"
							this._setupTwoWayBinding(currentElementNode, expr)
						else if (macroName === 'if') {
							ifDirectivesToProcess.push({ element: currentElementNode, expr })
						} else if (macroName === 'for')
							this._setupListRendering(currentElementNode, expr)
						else if (macroName === 'key') continue
						else console.warn(`Unknown macro: %${macroName}`)
					}
				}
			}

			// Save text binding relationships for updates
			this._textBindings = textBindings

			// Process all collected %if directives after the main traversal
			for (const { element: ifElement, expr } of ifDirectivesToProcess) {
				this._setupConditionRendering(ifElement, expr)
			}
		}

		// Handle two-way data binding (%connect macro)
		private _setupTwoWayBinding(element: Element, expr: string) {
			// Get the initial value
			const value = this._getNestedState(expr)

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
				this.setState(expr, newValue)
			})

			// Add event listener for state changes
			this._statesListeners[expr] = (newValue: unknown) => {
				if (element instanceof HTMLInputElement)
					element.value = newValue as string
				else element.setAttribute('data-laterano-connect', String(newValue))
			}
		}

		// Handle condition rendering (%if macro)
		private _setupConditionRendering(element: Element, expr: string) {
			const placeholder = document.createComment(` %if: ${expr} `)
			element.parentNode?.insertBefore(placeholder, element)

			this._conditionalElements.set(element, {
				expr,
				placeholder,
				isPresent: true,
			})

			this._evaluateIfCondition(element, expr)

			const statePaths = this._extractStatePathsFromExpression(expr)
			for (const path of statePaths) {
				if (!this._stateToElementsMap[path])
					this._stateToElementsMap[path] = new Set()
				this._stateToElementsMap[path].add(element as HTMLElement)
			}
		}

		// Handle list rendering (%for macro)
		private _setupListRendering(element: Element, expr: string) {
			// Parse the expression (e.g., "item in items" or "(item, index) in items")
			const match = expr.match(
				/(?:\(([^,]+),\s*([^)]+)\)|([^,\s]+))\s+in\s+(.+)/,
			)
			if (!match) {
				console.error(`Invalid %for expression: ${expr}`)
				return
			}

			// Extract the item variable name, index variable name (optional), and collection expression
			const itemVar = match[3] || match[1]
			const indexVar = match[2] || null
			const collectionExpr = match[4].trim()

			// Create a placeholder comment to mark where the list should be rendered
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
				const collection = this._evaluateExpression(collectionExpr)
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

				// Detach all currently rendered DOM items managed by this instance.
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
				// renderedItems.forEach((item) => {
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
						? this._evaluateExpressionWithItemContext(
								keyAttr ?? '',
								item,
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

					// insert %key attribute, which dynamically bind the key
					if (keyAttr) {
						const keyValue = this._evaluateExpressionWithItemContext(
							keyAttr,
							itemContext,
						)
						itemElement.setAttribute('data-laterano-key', String(keyValue))
					}

					// remove original %key attribute
					itemElement.removeAttribute('%key')

					// Apply the item context to the element
					// We will use recursive processing here!
					this._processElementWithItemContext(itemElement, itemContext)

					// Insert the element to the document fragment
					fragment.appendChild(itemElement)
				})

				// Insert the document fragment into the DOM
				placeholder.parentNode?.insertBefore(fragment, placeholder.nextSibling)

				// Remove any remaining unused items
				// existingElementsByKey.forEach((item) => {
				for (const item of existingElementsByKey.values())
					if (item.element.parentNode)
						item.element.parentNode.removeChild(item.element)
			}

			// Initial render
			updateList()

			// Set up state dependency for collection changes
			if (!this._stateToElementsMap[collectionExpr])
				this._stateToElementsMap[collectionExpr] = new Set()

			// Using a unique identifier for this list rendering instance
			const listVirtualElement = document.createElement('div')
			this._stateToElementsMap[collectionExpr].add(
				listVirtualElement as HTMLElement,
			)

			// Add listener for state changes
			this._statesListeners[collectionExpr] = () => {
				updateList()
			}
		}

		// Recursively process the element and its children, applying the item context
		private _processElementWithItemContext(
			element: Element,
			itemContext: Record<string, unknown>,
		) {
			// 1. Store the item context of the element so that subsequent updates can find it
			;(element as { _itemContext?: Record<string, unknown> })._itemContext =
				itemContext

			// 2. Process bindings in text nodes
			const processTextNodes = (node: Node) => {
				if (node.nodeType === Node.TEXT_NODE) {
					const textContent = node.textContent || ''
					if (textContent.includes('{{')) {
						const textNode = node as Text
						const updatedContent = textContent.replace(
							/\{\{\s*([^}]+)\s*\}\}/g,
							(match, expr) => {
								const value = this._evaluateExpressionWithItemContext(
									expr.trim(),
									itemContext,
								)
								return value !== undefined ? String(value) : ''
							},
						)
						textNode.textContent = updatedContent
					}
				}
			}

			// Process the text nodes of the element itself
			// Array.from(element.childNodes).forEach((node) => {
			for (const node of Array.from(element.childNodes))
				if (node.nodeType === Node.TEXT_NODE) processTextNodes(node)

			// 3. Process attribute bindings (:attr)
			// Array.from(element.attributes).forEach((attr) => {
			for (const attr of Array.from(element.attributes)) {
				if (attr.name.startsWith(':')) {
					const attrName = attr.name.substring(1)
					const expr = attr.value.trim()
					const value = this._evaluateExpressionWithItemContext(
						expr,
						itemContext,
					)

					if (value !== undefined) element.setAttribute(attrName, String(value))

					// Remove the original binding attribute (execute only for cloned templates once)
					element.removeAttribute(attr.name)
				}
			}

			// 4. Process event bindings (@event)
			// Array.from(element.attributes).forEach((attr) => {
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
								...this._createHandlerContext(event, element),
								...itemContext,
								$event: event,
								$el: element,
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

			// 5. Process conditional rendering (%if)
			let isConditional = false
			let shouldDisplay = true

			// Array.from(element.attributes).forEach((attr) => {
			for (const attr of Array.from(element.attributes)) {
				if (attr.name === '%if') {
					isConditional = true
					const expr = attr.value.trim()

					// Remove the original binding attribute
					element.removeAttribute(attr.name)

					// Calculate the condition
					const result = this._evaluateExpressionWithItemContext(
						expr,
						itemContext,
					)
					shouldDisplay = Boolean(result)

					// Apply the condition (in the list item context, we use display style to simplify)
					if (!shouldDisplay) (element as HTMLElement).style.display = 'none'
				}
			}

			// If the condition evaluates to false, skip further processing of this element
			if (isConditional && !shouldDisplay) {
				return
			}

			// 6. Process nested list rendering (%for)
			let hasForDirective = false

			// Array.from(element.attributes).forEach((attr) => {
			for (const attr of Array.from(element.attributes)) {
				if (attr.name === '%for') {
					hasForDirective = true
					const forExpr = attr.value.trim()

					// Remove the original binding attribute
					element.removeAttribute(attr.name)

					// Here we will create a new nested list
					// Note: We need to evaluate the collection expression through the current item context here
					this._setupNestedListRendering(element, forExpr, itemContext)
				}
			}

			// If this element is a list element, skip child element processing (they will be processed by the list processor)
			if (hasForDirective) return

			// 7. Recursively process all child elements
			// Array.from(element.children).forEach((child) => {
			for (const child of Array.from(element.children))
				this._processElementWithItemContext(child, itemContext)
		}

		// Set up nested list rendering
		private _setupNestedListRendering(
			element: Element,
			expr: string,
			parentItemContext: Record<string, unknown>,
		) {
			// Similar to _setupListRendering, but applies to nested situations
			// Parse the expression (e.g., "subItem in item.subItems")
			const match = expr.match(
				/(?:\(([^,]+),\s*([^)]+)\)|([^,\s]+))\s+in\s+(.+)/,
			)
			if (!match) {
				console.error(`Invalid nested %for expression: ${expr}`)
				return
			}

			// Extract the item variable name, index variable name (optional), and collection expression
			const itemVar = match[3] || match[1]
			const indexVar = match[2] || null
			const collectionExpr = match[4].trim()

			// Evaluate the collection expression, using the parent item context
			const collection = this._evaluateExpressionWithItemContext(
				collectionExpr,
				parentItemContext,
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
				this._processElementWithItemContext(itemElement, nestedItemContext)

				// TODO: detect list items existed inside the view, use replace instead of remove and re-add,
				// to improve performance

				// Insert the item element into the DOM
				placeholder.parentNode?.insertBefore(
					itemElement,
					placeholder.nextSibling,
				)
			})
		}

		// Evaluate expressions using the item context
		private _evaluateExpressionWithItemContext(
			expression: string,
			itemContext: Record<string, unknown>,
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
				const mergedContext = { ...this._states, ...itemContext }

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

		private _evaluateIfCondition(element: Element, condition: string) {
			const info = this._conditionalElements.get(element)
			if (!info) return

			// Evaluate the condition
			const result = this._evaluateExpression(condition)
			const shouldShow = Boolean(result)

			if (shouldShow !== info.isPresent) {
				if (shouldShow)
					// Insert the element back into the DOM
					info.placeholder.parentNode?.insertBefore(
						element,
						info.placeholder.nextSibling,
					)
				// Remove the element from the DOM
				else element.parentNode?.removeChild(element)

				// Update the state
				info.isPresent = shouldShow
				this._conditionalElements.set(element, info)
			}
		}

		private _evaluateExpression(expression: string): unknown {
			try {
				// get the state keys and values
				if (this._states[expression] !== undefined)
					return this._states[expression]

				// execute the expression
				const stateKeys = Object.keys(this._states)
				const stateValues = Object.values(this._states)

				const func = new Function(...stateKeys, `return ${expression}`)
				const execRes = func(...stateValues)
				if (typeof execRes !== 'boolean')
					throw new Error(
						`The expression "${expression}" must return a boolean value.`,
					)
				return execRes
			} catch (error) {
				console.error(`Error evaluating expression: ${expression}`, error)
				return undefined
			}
		}

		private _extractStatePathsFromExpression(expression: string): string[] {
			const matches = expression.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || []
			return matches.filter(
				(match) =>
					!['true', 'false', 'null', 'undefined', 'this'].includes(match),
			)
		}

		// Handle arrow function
		private _setupArrowFunctionHandler(
			element: Element,
			eventName: string,
			handlerValue: string,
		) {
			element.addEventListener(eventName, (event: Event) => {
				try {
					// Arrow function parsing
					const splitted = handlerValue.split('=>')
					if (splitted.length !== 2) {
						throw new Error(`Invalid arrow function syntax: ${handlerValue}`)
					}
					const paramsStr = (() => {
						if (splitted[0].includes('(')) return splitted[0].trim()
						return `(${splitted[0].trim()})`
					})()
					const bodyStr = splitted[1].trim()

					// Check if the function body is wrapped in {}
					const isMultiline = bodyStr.startsWith('{') && bodyStr.endsWith('}')

					// If it is a multiline function body, remove the outer braces
					if (isMultiline) {
						// Remove the outer braces
						let bodyStr = handlerValue.split('=>')[1].trim()
						bodyStr = bodyStr.substring(1, bodyStr.length - 1)

						// Build code for multiline arrow function
						const functionCode = `
									return function${paramsStr} {
										${bodyStr}
									}
								`

						// Create context object
						const context = this._createHandlerContext(event, element)

						// Create and call function
						const handlerFn = new Function(functionCode).call(null)
						handlerFn.apply(context, [event])
					} else {
						// Single line arrow function, directly return expression result
						const functionCode = `
									return function${paramsStr} {
										return ${bodyStr}
									}
								`

						// Create context object
						const context = this._createHandlerContext(event, element)

						// Create and call function
						const handlerFn = new Function(functionCode).call(null)
						handlerFn.apply(context, [event])
					}
				} catch (err) {
					console.error(
						`Error executing arrow function handler: ${handlerValue}`,
						err,
					)
				}
			})
		}

		// Create handler context
		private _createHandlerContext(event: Event, element: Element) {
			// Basic context, including state
			const context: {
				[key: string]: unknown
				$event: Event
				$el: Element
				this: CustomElementImpl // Provide reference to the component instance
				setState: (keyPath: string, value: unknown) => void
				getState: (keyPath: string) => unknown
			} = {
				...this._states,
				$event: event,
				$el: element,
				this: this, // Provide reference to the component instance
				setState: this.setState.bind(this),
				getState: this.getState.bind(this),
			}

			// Add all methods of the component
			// Object.getOwnPropertyNames(Object.getPrototypeOf(this)).forEach(
			// 	(name) => {
			for (const name of Object.getOwnPropertyNames(
				Object.getPrototypeOf(this),
			))
				if (
					typeof (this as Record<string, unknown>)[name] === 'function' &&
					name !== 'constructor'
				)
					context[name] = (
						this as unknown as Record<string, (...args: unknown[]) => void>
					)[name].bind(this)

			return context
		}

		// Handle function call, such as @click="increment(5)"
		private _setupFunctionCallHandler(
			element: Element,
			eventName: string,
			handlerValue: string,
		) {
			element.addEventListener(eventName, (event: Event) => {
				try {
					// Create context object
					const context = this._createHandlerContext(event, element)

					// Create and execute function call
					const fnStr = `
							with(this) {
								${handlerValue}
							}
						`

					new Function(fnStr).call(context)
				} catch (err) {
					console.error(
						`Error executing function call handler: ${handlerValue}`,
						err,
					)
				}
			})
		}

		// Handle simple expression, such as @click="count++" or @input="name = $event.target.value"
		private _setupExpressionHandler(
			element: Element,
			eventName: string,
			handlerValue: string,
		) {
			element.addEventListener(eventName, (event: Event) => {
				try {
					// Create context object
					const context = this._createHandlerContext(event, element)

					// Create expression function
					const fnStr = `
							with(this) {
								${handlerValue}
							}
						`

					// Execute expression
					const result = new Function(fnStr).call(context)

					// If the expression returns a value, it can be used for two-way binding
					return result
				} catch (err) {
					console.error(
						`Error executing expression handler: ${handlerValue}`,
						err,
					)
				}
			})
		}

		// Update text node
		private _updateTextNode(node: Text, expr: string, template: string) {
			// Replace all expressions with the current state value
			let newContent = template

			const replaceExpr = (match: string, expr: string) => {
				// Get the value of the expression
				const value = this._getNestedState(expr.trim())
				return value !== undefined ? String(value) : ''
			}

			// Replace all {{ xxx }} expressions
			newContent = newContent.replace(/\{\{\s*([^}]+)\s*\}\}/g, replaceExpr)

			// Update node content
			node.textContent = newContent
		}

		// Set up attribute binding
		private _setupAttributeBinding(
			element: Element,
			attrName: string,
			expr: string,
			template: string,
		) {
			// Initialize attribute value
			const value = this._getNestedState(expr)

			// Set the initial attribute
			if (value !== undefined) {
				element.setAttribute(attrName, String(value))
			}

			// Add update function to the map
			if (!this._attributeBindings) {
				this._attributeBindings = []
			}

			this._attributeBindings.push({
				element,
				attrName,
				expr,
				template,
			})
		}

		// Get nested state value
		private _getNestedState(path: string): unknown {
			// Handle nested paths, such as "profile.name"
			const parts = path.split('.')
			let result = this._states

			for (const part of parts) {
				if (result === undefined || result === null) return undefined
				result = (result as { [key: string]: Record<string, unknown> })[part]
			}

			return result
		}

		connectedCallback() {
			if (onMount) onMount.call(this)
		}

		disconnectedCallback() {
			if (onUnmount) onUnmount.call(this)
		}

		static get observedAttributes() {
			return ['data-attribute']
		}

		attributeChangedCallback(
			attrName: string,
			oldValue: string,
			newValue: string,
		) {
			if (onAttributeChanged) onAttributeChanged(attrName, oldValue, newValue)
		}

		// state manager
		setState(keyPath: string, value: unknown) {
			this._states[keyPath] = value
		}

		getState(keyPath: string): unknown {
			const parts = keyPath.split('.')
			let result = this._states
			for (const part of parts) {
				if (result === undefined || result === null) return undefined
				result = (result as { [key: string]: Record<string, unknown> })[part]
			}
			return result
		}

		// function trigger
		triggerFunc(eventName: string, ...args: unknown[]) {
			funcs?.[eventName]?.call(this, ...args)
		}
	}

	customElements.define(tag, CustomElementImpl)
}
