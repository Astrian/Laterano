export default (options: ComponentOptions) => {
	const { tag, template, style, onMount, onUnmount, onAttributeChanged } = options

	class CustomElement extends HTMLElement {
		constructor() {
			super()
			this.attachShadow({ mode: 'open' })
			this.shadowRoot!.innerHTML = `
				<style>${style}</style>
				${template}
			`
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