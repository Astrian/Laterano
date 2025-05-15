interface CustomElement extends HTMLElement {
	setState(key_path: string, value: any): void
	getState(key_path: string): any
}

interface ComponentOptions {
	tag: string
	template: string
	style?: string
	onMount?: (this: CustomElement) => void
	onUnmount?: () => void
	onAttributeChanged?: (attrName: string, oldValue: string, newValue: string) => void
	states?: Record<string, any>
	statesListeners?: { [key: string]: (value: any) => void }
	events?: { [key: string]: (event: Event) => void }
}

export default (options: ComponentOptions) => {
	const { tag, template, style, onMount, onUnmount, onAttributeChanged, states, statesListeners } = options
	const componentRegistry = new Map()
	componentRegistry.set(tag, options)

	class CustomElementImpl extends HTMLElement {
		private _states: Record<string, any> = {}
		private _stateToElementsMap: Record<string, Set<HTMLElement>> = {}
		private _currentRenderingElement: HTMLElement | null = null
		private _statesListeners: Record<string, Function> = {}
		private _textBindings: Array<{ node: Text, expr: string, originalContent: string }> = []
		private _attributeBindings: Array<{ element: Element, attrName: string, expr: string, template: string }> = []
		private _conditionalElements: Map<Element, {
			expr: string,
			placeholder: Comment,
			isPresent: boolean
		}> = new Map()

		constructor() {
			super()

			// copy state from options
			this._states = new Proxy({ ...(states || {}) }, {
				set: (target: Record<string, any>, keyPath: string, value: any) => {
					const valueRoute = keyPath.split('.')
					let currentTarget = target
					for (let i in valueRoute) {
						const key = valueRoute[i]
						if (parseInt(i) === valueRoute.length - 1) {
							currentTarget[key] = value
						} else {
							if (!currentTarget[key]) {
								currentTarget[key] = {}
							}
							currentTarget = currentTarget[key]
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
					if (statesListeners && statesListeners[keyPath])
						statesListeners[keyPath](value)

					return true
				},
				get: (target: Record<string, any>, keyPath: string) => {
					// collect state dependencies
					if (this._currentRenderingElement) {
						if (!this._stateToElementsMap[keyPath])
							this._stateToElementsMap[keyPath] = new Set()
						this._stateToElementsMap[keyPath].add(this._currentRenderingElement)
					}

					const valueRoute = keyPath.split('.')
					let currentTarget = target
					for (let i in valueRoute) {
						const key = valueRoute[i]
						if (parseInt(i) === valueRoute.length - 1) {
							return currentTarget[key]
						} else {
							if (!currentTarget[key]) {
								currentTarget[key] = {}
							}
							currentTarget = currentTarget[key]
						}
					}
					return undefined
				}
			})

			// initialize dom tree and append to shadow root
			this._initialize()
		}

		private _initialize() {
			// initialize shadow dom
			const shadow = this.attachShadow({ mode: 'open' })

			if (style) {
				const styleElement = document.createElement('style')
				styleElement.textContent = style
				this.shadowRoot?.appendChild(styleElement)
			}

			const parser = new DOMParser()
			const doc = parser.parseFromString(template, 'text/html')

			const mainContent = doc.body.firstElementChild
			let rootElement

			if (mainContent) {
				rootElement = document.importNode(mainContent, true)
				shadow.appendChild(rootElement)
			} else {
				const container = document.createElement('div')
				container.innerHTML = template
				rootElement = container
				shadow.appendChild(container)
			}

			this._processTemplateMarcos(rootElement)
		}

		private _triggerDomUpdates(keyPath: string) {
			if (this._stateToElementsMap[keyPath]) {
				const updateQueue = new Set<HTMLElement>()

				this._stateToElementsMap[keyPath].forEach(element => {
					updateQueue.add(element)
				})

				this._scheduleUpdate(updateQueue)
			}

			// Update text bindings that depend on this state
			if (this._textBindings) {
				this._textBindings.forEach(binding => {
					if (binding.expr === keyPath || binding.expr.startsWith(keyPath + '.')) {
						this._updateTextNode(binding.node, binding.expr, binding.originalContent)
					}
				})
			}

			// Update attribute bindings that depend on this state
			if (this._attributeBindings) {
				this._attributeBindings.forEach(binding => {
					if (binding.expr === keyPath || binding.expr.startsWith(keyPath + '.')) {
						const value = this._getNestedState(binding.expr)
						if (value !== undefined) {
							binding.element.setAttribute(binding.attrName, String(value))
						}
					}
				})
			}
		}

		private _scheduleUpdate(elements: Set<HTMLElement>) {
			requestAnimationFrame(() => {
				elements.forEach(element => {
					this._updateElement(element)
				})
			})
		}

		private _updateElement(element: HTMLElement) {
			const renderFunction = (element as any)._renderFunction
			if (renderFunction) {
				// Set rendering context
				this._currentRenderingElement = element

				// Execute rendering
				const result = renderFunction()

				// Update DOM
				if (typeof result === 'string') {
					element.innerHTML = result
				} else if (result instanceof Node) {
					element.innerHTML = ''
					element.appendChild(result)
				}

				// Clear rendering context
				this._currentRenderingElement = null
			}
		}

		private _processTemplateMarcos(element: Element) {
			/*
			 * We define that those prefix are available as macros:
			 * - @ means event binding marco, such as @click="handleClick"
			 * - : means dynamic attribute marco, such as :src="imageUrl"
			 * - % means component controlling marco, such as %if="condition", %for="item in items" and %connect="stateName"
			 */

			// Traverse all child nodes, including text nodes
			const walker = document.createTreeWalker(
				element,
				NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
				null
			)

			// Store nodes and expressions that need to be updated
			const textBindings: Array<{ node: Text, expr: string, originalContent: string }> = []
			const ifDirectivesToProcess: Array<{ element: Element, expr: string }> = []

			// Traverse the DOM tree
			let currentNode: Node | null
			while (currentNode = walker.nextNode()) {
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
							matches.forEach(match => {
								// Extract the expression content, removing {{ }} and spaces
								const expr = match.replace(/\{\{\s*|\s*\}\}/g, '').trim()

								// Store the node, expression, and original content for later updates
								textBindings.push({ node: textNode, expr, originalContent })

								// Set the initial value
								this._updateTextNode(textNode, expr, originalContent)

								// Add dependency relationship for this state path
								if (!this._stateToElementsMap[expr]) {
									this._stateToElementsMap[expr] = new Set()
								}
								this._stateToElementsMap[expr].add(textNode as unknown as HTMLElement)
							})
						}
					}
				}

				// Handle element nodes (can extend to handle attribute bindings, etc.)
				else if (currentNode.nodeType === Node.ELEMENT_NODE) {

					const currentElementNode = currentNode as Element // Renamed to avoid conflict with outer 'element'

					// Traverse all marco attributes

					// Detect :attr="" bindings, such as :src="imageUrl"
					Array.from(currentElementNode.attributes).forEach(attr => {
						if (attr.name.startsWith(':')) {
							const attrName = attr.name.substring(1) // Remove ':'
							const expr = attr.value.trim()

							// Remove the attribute, as it is not a standard HTML attribute
							currentElementNode.removeAttribute(attr.name)

							// Set up attribute binding
							this._setupAttributeBinding(currentElementNode, attrName, expr, attr.value)
						}
					})

					// Process @event bindings, such as @click="handleClick"
					const eventBindings = Array.from(currentElementNode.attributes).filter(attr => attr.name.startsWith('@'))
					eventBindings.forEach(attr => {
						const eventName = attr.name.substring(1) // Remove '@'
						const handlerValue = attr.value.trim()

						// Remove the attribute, as it is not a standard HTML attribute
						currentElementNode.removeAttribute(attr.name)

						// Handle different types of event handlers
						if (handlerValue.includes('=>')) {
							// Handle arrow function: @click="e => setState('count', count + 1)"
							this._setupArrowFunctionHandler(currentElementNode, eventName, handlerValue)
						} else if (handlerValue.includes('(') && handlerValue.includes(')')) {
							// Handle function call: @click="increment(5)"
							this._setupFunctionCallHandler(currentElementNode, eventName, handlerValue)
						} else if (typeof (this as any)[handlerValue] === 'function') {
							// Handle method reference: @click="handleClick"
							currentElementNode.addEventListener(eventName, (this as any)[handlerValue].bind(this))
						} else {
							// Handle simple expression: @click="count++" or @input="name = $event.target.value"
							this._setupExpressionHandler(currentElementNode, eventName, handlerValue)
						}
					})

					// Process %-started marcos, such as %connect="stateName", %if="condition", %for="item in items"
					const macroBindings = Array.from(currentElementNode.attributes).filter(attr => attr.name.startsWith('%'))
					macroBindings.forEach(attr => {
						const macroName = attr.name.substring(1) // Remove '%'
						const expr = attr.value.trim()

						// Remove the attribute, as it is not a standard HTML attribute
						currentElementNode.removeAttribute(attr.name)

						// Handle different types of macros
						if (macroName === 'connect') // Handle state connection: %connect="stateName"
							this._setupTwoWayBinding(currentElementNode, expr)
						else if (macroName === 'if')
							ifDirectivesToProcess.push({ element: currentElementNode, expr })
						else if (macroName === 'for') {
							// detect %key="keyName" attribute
							const keyAttr = currentElementNode.getAttribute('%key')
							if (!keyAttr)
								return console.error(`%for macro requires %key attribute: %for="${expr}"`)
							this._setupListRendering(currentElementNode, expr, keyAttr)
						} else if (macroName === 'key') // Ignore %key macro, as it is handled in %for
							return
						else
							console.warn(`Unknown macro: %${macroName}`)
					})


				}
			}

			// Save text binding relationships for updates
			this._textBindings = textBindings

			// Process all collected %if directives after the main traversal
			for (const { element: ifElement, expr } of ifDirectivesToProcess) {
				this._setupConditionRendering(ifElement, expr)
			}
		}

		// Handle two-way data binding (%connect marco)
		private _setupTwoWayBinding(element: Element, expr: string) {
			// Get the initial value
			const value = this._getNestedState(expr)

			// Set the initial value
			if (value !== undefined)
				element.setAttribute('data-laterano-connect', String(value))
			else
				console.error(`State \`${expr}\` not found in the component state. Although Laterano will try to work with it, it may has potentially unexpected behavior.`)

			// Add event listener for input events
			element.addEventListener('input', (event: Event) => {
				const target = event.target as HTMLInputElement
				const newValue = target.value

				// Update the state
				this.setState(expr, newValue)
			})

			// Add event listener for state changes
			this._statesListeners[expr] = (newValue: any) => {
				if (element instanceof HTMLInputElement) {
					element.value = newValue
				} else {
					element.setAttribute('data-laterano-connect', String(newValue))
				}
			}
		}

		// Handle condition rendering (%if marco)
		private _setupConditionRendering(element: Element, expr: string) {

			const placeholder = document.createComment(` %if: ${expr} `)
			element.parentNode?.insertBefore(placeholder, element)

			this._conditionalElements.set(element, {
				expr,
				placeholder,
				isPresent: true
			})

			this._evaluateIfCondition(element, expr)

			const statePaths = this._extractStatePathsFromExpression(expr)
			statePaths.forEach(path => {
				if (!this._stateToElementsMap[path]) {
					this._stateToElementsMap[path] = new Set()
				}
				this._stateToElementsMap[path].add(element as HTMLElement)
			})
		}

		// Handle list rendering (%for macro)
		private _setupListRendering(element: Element, expr: string, keyAttr: string) {
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

			// Create a placeholder comment to mark where the list should be rendered
			const placeholder = document.createComment(` %for: ${expr} `)
			element.parentNode?.insertBefore(placeholder, element)

			// Remove the original template element from the DOM
			const template = element.cloneNode(true) as Element
			element.parentNode?.removeChild(element)

			// Store current rendered items
			const renderedItems: Array<{
				element: Element,
				key: any,
				data: any,
				index: number
			}> = []

			// Create a function to update the list when the collection changes
			const updateList = () => {
				const collection = this._getNestedState(collectionExpr)
				if (!collection || !Array.isArray(collection)) {
					console.warn(`Collection "${collectionExpr}" is not an array or does not exist`)
					return
				}

				// Get key attribute if available
				const keyAttr = template.getAttribute('data-laterano-for')

				// Store a map of existing items by key for reuse
				const existingElementsByKey = new Map()
				renderedItems.forEach(item => {
					if (item.key !== undefined) {
						existingElementsByKey.set(item.key, item)
					}
				})

				// Clear rendered items
				renderedItems.length = 0

				// Create or update items in the list
				collection.forEach((item, index) => {
					// Determine the key for this item
					const key = keyAttr ? this._evaluateKeyExpression(keyAttr, item, index, itemVar) : index

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

						// Process template macros for this new element
						this._processTemplateMarcos(itemElement)
					}

					// Update item data
					renderedItems.push({
						element: itemElement,
						key,
						data: item,
						index
					})

					// Create rendering context for this item
					const itemContext = { [itemVar]: item }
					if (indexVar) {
						itemContext[indexVar] = index
					}

					// Apply the item context to the element
					this._applyItemContext(itemElement, itemContext)

					// Insert the element at the correct position in the DOM
					placeholder.parentNode?.insertBefore(itemElement, placeholder.nextSibling)
				})

				// Remove any remaining unused items
				existingElementsByKey.forEach(item => {
					if (item.element.parentNode) {
						item.element.parentNode.removeChild(item.element)
					}
				})
			}

			// Initial render
			updateList()

			// Set up state dependency for collection changes
			if (!this._stateToElementsMap[collectionExpr]) {
				this._stateToElementsMap[collectionExpr] = new Set()
			}
			// Using a unique identifier for this list rendering instance
			const listVirtualElement = document.createElement('div')
			this._stateToElementsMap[collectionExpr].add(listVirtualElement as HTMLElement)

			// Add listener for state changes
			this._statesListeners[collectionExpr] = () => {
				updateList()
			}
		}

		// Helper method to evaluate key expressions for list items
		private _evaluateKeyExpression(keyExpr: string, itemData: any, index: number, itemVar: string): any {
			try {
				// If keyExpr is directly the item property, return it
				if (keyExpr === itemVar) {
					return itemData
				}

				// If keyExpr is a property path like "item.id", extract it
				if (keyExpr.startsWith(itemVar + '.')) {
					const propertyPath = keyExpr.substring(itemVar.length + 1)
					const parts = propertyPath.split('.')
					let value = itemData

					for (const part of parts) {
						if (value === undefined || value === null) {
							return undefined
						}
						value = value[part]
					}

					return value
				}

				// Otherwise, evaluate as an expression
				const func = new Function(itemVar, 'index', `return ${keyExpr}`)
				return func(itemData, index)
			} catch (error) {
				console.error(`Error evaluating key expression: ${keyExpr}`, error)
				return index // Fallback to index as key
			}
		}

		// Helper method to apply item context to elements
		private _applyItemContext(element: Element, itemContext: Record<string, any>) {
			// Store the item context on the element
			(element as any)._itemContext = itemContext

			// Update text nodes with handlebars expressions
			const updateTextNodes = (node: Node) => {
				if (node.nodeType === Node.TEXT_NODE) {
					const textContent = node.textContent || ''

					if (textContent.includes('{{')) {
						const textNode = node as Text
						const originalContent = textContent

						// Replace expressions with values from item context
						let newContent = originalContent.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, expr) => {
							// Check if expression references item context
							const contextVarNames = Object.keys(itemContext)
							const usesContext = contextVarNames.some(varName => expr.includes(varName))

							if (usesContext) {
								try {
									// Create a function that evaluates the expression with the item context
									const contextValues = Object.values(itemContext)
									const func = new Function(...contextVarNames, `return ${expr.trim()}`)
									const result = func(...contextValues)
									return result !== undefined ? String(result) : ''
								} catch (error) {
									console.error(`Error evaluating expression in list item: ${expr}`, error)
									return ''
								}
							} else {
								// Use the regular state value if not from item context
								const value = this._getNestedState(expr.trim())
								return value !== undefined ? String(value) : ''
							}
						})

						textNode.textContent = newContent
					}
				}

				// Recursively process child nodes
				const childNodes = node.childNodes
				for (let i = 0; i < childNodes.length; i++) {
					updateTextNodes(childNodes[i])
				}
			}

			// Update text nodes
			updateTextNodes(element)

			// Also handle event handlers and other bindings if needed
			// This is more complex and would require extending other methods
			// to be aware of the item context
		}

		private _evaluateIfCondition(element: Element, condition: string) {
			const info = this._conditionalElements.get(element)
			if (!info) return

			// Evaluate the condition
			const result = this._evaluateExpression(condition)
			const shouldShow = Boolean(result)

			if (shouldShow !== info.isPresent) {
				if (shouldShow) // Insert the element back into the DOM
					info.placeholder.parentNode?.insertBefore(element, info.placeholder.nextSibling)
				else // Remove the element from the DOM
					element.parentNode?.removeChild(element)

				// Update the state
				info.isPresent = shouldShow
				this._conditionalElements.set(element, info)
			}
		}

		private _evaluateExpression(expression: string): any {
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
					throw new Error(`The expression "${expression}" must return a boolean value.`)
				return execRes
			} catch (error) {
				console.error(`Error evaluating expression: ${expression}`, error)
				return undefined
			}
		}

		private _extractStatePathsFromExpression(expression: string): string[] {
			const matches = expression.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || []
			return matches.filter(match =>
				!['true', 'false', 'null', 'undefined', 'this'].includes(match)
			)
		}

		// Handle arrow function
		private _setupArrowFunctionHandler(element: Element, eventName: string, handlerValue: string) {
			element.addEventListener(eventName, (event: Event) => {
				try {
					// Arrow function parsing
					const splitted = handlerValue.split('=>')
					if (splitted.length !== 2) {
						throw new Error(`Invalid arrow function syntax: ${handlerValue}`)
					}
					const paramsStr = (() => {
						if (splitted[0].includes('(')) {
							return splitted[0].trim()
						} else {
							return `(${splitted[0].trim()})`
						}
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
					console.error(`Error executing arrow function handler: ${handlerValue}`, err)
				}
			})
		}

		// Create handler context
		private _createHandlerContext(event: Event, element: Element) {
			// Basic context, including state
			const context: {
				[key: string]: any
				$event: Event
				$el: Element
				this: CustomElementImpl // Provide reference to the component instance
				setState: (keyPath: string, value: any) => void
				getState: (keyPath: string) => any
			} = {
				...this._states,
				$event: event,
				$el: element,
				this: this, // Provide reference to the component instance
				setState: this.setState.bind(this),
				getState: this.getState.bind(this)
			}

			// Add all methods of the component
			Object.getOwnPropertyNames(Object.getPrototypeOf(this)).forEach(name => {
				if (typeof (this as any)[name] === 'function' && name !== 'constructor') {
					context[name] = (this as any)[name].bind(this)
				}
			})

			return context
		}

		// Handle function call, such as @click="increment(5)"
		private _setupFunctionCallHandler(element: Element, eventName: string, handlerValue: string) {
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
					console.error(`Error executing function call handler: ${handlerValue}`, err)
				}
			})
		}

		// Handle simple expression, such as @click="count++" or @input="name = $event.target.value"
		private _setupExpressionHandler(element: Element, eventName: string, handlerValue: string) {
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
					console.error(`Error executing expression handler: ${handlerValue}`, err)
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
		private _setupAttributeBinding(element: Element, attrName: string, expr: string, template: string) {
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
				template
			})
		}

		// Get nested state value
		private _getNestedState(path: string): any {
			// Handle nested paths, such as "profile.name"
			const parts = path.split('.')
			let result = this._states

			for (const part of parts) {
				if (result === undefined || result === null) {
					return undefined
				}
				result = result[part]
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

		attributeChangedCallback(attrName: string, oldValue: string, newValue: string) {
			if (onAttributeChanged) onAttributeChanged(attrName, oldValue, newValue)
		}

		// state manager
		setState(keyPath: string, value: any) {
			this._states[keyPath] = value
		}

		getState(keyPath: string) {
			return this._states[keyPath]
		}
	}

	customElements.define(tag, CustomElementImpl)
}