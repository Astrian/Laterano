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

					// trigger state update events
					if (statesListeners && statesListeners[keyPath]) {
						statesListeners[keyPath](value)
					}

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

			this._processTemplateBindings(rootElement)
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

		private _processTemplateBindings(element: Element) {
			// Traverse all child nodes, including text nodes
			const walker = document.createTreeWalker(
				element,
				NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
				null
			)

			// Store nodes and expressions that need to be updated
			const textBindings: Array<{ node: Text, expr: string, originalContent: string }> = []

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
					// Handle element attribute bindings, such as <img src="{{ imageUrl }}">
					const element = currentNode as Element

					// Traverse all attributes
					Array.from(element.attributes).forEach(attr => {
						const value = attr.value
						if (value.includes('{{')) {
							// Extract the expression
							const matches = value.match(/\{\{\s*([^}]+)\s*\}\}/g)
							if (matches) {
								matches.forEach(match => {
									const expr = match.replace(/\{\{\s*|\s*\}\}/g, '').trim()

									// For attribute bindings, we need a special update function
									this._setupAttributeBinding(element, attr.name, expr, value)

									// Record dependency relationship
									if (!this._stateToElementsMap[expr]) {
										this._stateToElementsMap[expr] = new Set()
									}
									this._stateToElementsMap[expr].add(element as HTMLElement)
								})
							}
						}
					})

					// Process @event bindings, such as @click="handleClick"
					const eventBindings = Array.from(element.attributes).filter(attr => attr.name.startsWith('@'))
					eventBindings.forEach(attr => {
						const eventName = attr.name.substring(1) // Remove '@'
						const handlerValue = attr.value.trim()

						// Remove the attribute, as it is not a standard HTML attribute
						element.removeAttribute(attr.name)

						// Handle different types of event handlers
						if (handlerValue.includes('=>')) {
							// Handle arrow function: @click="e => setState('count', count + 1)"
							this._setupArrowFunctionHandler(element, eventName, handlerValue)
						} else if (handlerValue.includes('(') && handlerValue.includes(')')) {
							// Handle function call: @click="increment(5)"
							this._setupFunctionCallHandler(element, eventName, handlerValue)
						} else if (typeof (this as any)[handlerValue] === 'function') {
							// Handle method reference: @click="handleClick"
							element.addEventListener(eventName, (this as any)[handlerValue].bind(this))
						} else {
							// Handle simple expression: @click="count++" or @input="name = $event.target.value"
							this._setupExpressionHandler(element, eventName, handlerValue)
						}
					})

				}
			}

			// Save text binding relationships for updates
			this._textBindings = textBindings
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