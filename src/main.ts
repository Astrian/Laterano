interface ComponentOptions {
	tag: string
	template: string
	style?: string
	onMount?: () => void
	onUnmount?: () => void
	onAttributeChanged?: (attrName: string, oldValue: string, newValue: string) => void
}

export default (options: ComponentOptions) => {
	const { tag, template, style, onMount, onUnmount, onAttributeChanged } = options
	const componentRegistry = new Map()
	componentRegistry.set(tag, options)

	const domTree = document.createElement('template')

	class CustomElement extends HTMLElement {
		constructor() {
			super()
			this.attachShadow({ mode: 'open' })
			this._initialize()
		}

		private _initialize() {
			if (style) {
				const styleElement = document.createElement('style')
				styleElement.textContent = style
				this.shadowRoot?.appendChild(styleElement)
			}
			
			// 使用 text/html 解析，这更适合处理 HTML 模板
			const parser = new DOMParser()
			const doc = parser.parseFromString(template, 'text/html')
			
			// 找到并导入主要内容元素
			const mainContent = doc.body.firstElementChild
			if (mainContent) {
				// 使用 importNode 确保所有事件和属性都被正确复制
				this.shadowRoot?.appendChild(document.importNode(mainContent, true))
			} else {
				// 如果没有根元素，将所有内容放入一个新的 div 中
				const container = document.createElement('div')
				container.innerHTML = template
				this.shadowRoot?.appendChild(container)
			}
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