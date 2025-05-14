interface ComponentOptions {
	tag: string
	template: string
	style?: string
	onMount?: () => void
	onUnmount?: () => void
	onAttributeChanged?: (attrName: string, oldValue: string, newValue: string) => void
	states?: Record<string, any>
}

export default (options: ComponentOptions) => {
	const { tag, template, style, onMount, onUnmount, onAttributeChanged, states } = options
	const componentRegistry = new Map()
	componentRegistry.set(tag, options)

	class CustomElement extends HTMLElement {
		private _states: Record<string, any> = {}

		constructor() {
			super()

			// copy state from options
			this._states = new Proxy({ ...(states || {}) }, {
				set: (target: Record<string, any>, prop: string, value: any) => {
					target[prop] = value
					// TODO: trigger dom updates
					// TODO: trigger state update events
					return true
				},
				get: (target: Record<string, any>, prop: string) => {
					return target[prop]
				}
			})

			// initialize shadow dom
			this.attachShadow({ mode: 'open' })

			// initialize dom tree and append to shadow root
			this._initialize()
		}

		private _initialize() {
			if (style) {
				const styleElement = document.createElement('style')
				styleElement.textContent = style
				this.shadowRoot?.appendChild(styleElement)
			}
			
			const parser = new DOMParser()
			const doc = parser.parseFromString(template, 'text/html')
			
			const mainContent = doc.body.firstElementChild
			if (mainContent) {
				this.shadowRoot?.appendChild(document.importNode(mainContent, true))
			} else {
				const container = document.createElement('div')
				container.innerHTML = template
				this.shadowRoot?.appendChild(container)
			}

			// TODO: generate a dom tracking machanism
		}

		connectedCallback() {
			if (onMount) onMount()
		}

		disconnectedCallback() {
			if (onUnmount) onUnmount()
		}

		static get observedAttributes() {
			return ['data-attribute']
		}

		attributeChangedCallback(attrName: string, oldValue: string, newValue: string) {
			if (onAttributeChanged) onAttributeChanged(attrName, oldValue, newValue)
		}
	}

	customElements.define(tag, CustomElement)
}