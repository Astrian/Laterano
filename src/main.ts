import utils from './utils/index'

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

			// initialize dom tree and append to shadow root, as well as initialize state
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
						utils.triggerDomUpdates(keyPath, {
							stateToElementsMap: this._stateToElementsMap,
							textBindings: this._textBindings,
							attributeBindings: this._attributeBindings,
							updateTextNode: this._updateTextNode.bind(this),
							getNestedState: this._getNestedState.bind(this),
							scheduleUpdate: this._scheduleUpdate.bind(this),
						})
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

			const rootElement = utils.parseTemplate(template)
			shadow.appendChild(rootElement)

			utils.processTemplateMacros(rootElement, this, {
				updateTextNode: this._updateTextNode.bind(this),
				setupAttributeBinding: this._setupAttributeBinding.bind(this),
				setupExpressionHandler: this._setupExpressionHandler.bind(this),
				setupFunctionCallHandler: this._setupFunctionCallHandler.bind(this),
				stateToElementsMap: this._stateToElementsMap,
				textBindings: this._textBindings,
				availableFuncs: Object.getOwnPropertyNames(
					Object.getPrototypeOf(this),
				).filter(
					(name) =>
						typeof (this as Record<string, unknown>)[name] === 'function' &&
						name !== 'constructor',
				),
				stateListeners: this._statesListeners,
				conditionalElements: this._conditionalElements,
				evaluateIfCondition: this._evaluateIfCondition.bind(this),
				extractStatePathsFromExpression:
					this._extractStatePathsFromExpression.bind(this),
				states: this._states,
				triggerFunc: this.triggerFunc.bind(this),
				// setupArrowFunctionHandler: utils.setupArrowFunctionHandler.bind(this),
			})
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
		private _updateTextNode(node: Text, _expr: string, template: string) {
			// Replace all expressions with the current state value
			let newContent = template

			const replaceExpr = (_match: string, expr: string) => {
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
