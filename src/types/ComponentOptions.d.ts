interface ComponentOptions {
	tag: string
	template: string
	style?: string
	onMount?: () => void
	onUnmount?: () => void
	onAttributeChanged?: (attrName: string, oldValue: string, newValue: string) => void
}