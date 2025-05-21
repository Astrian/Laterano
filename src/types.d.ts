interface CustomElement extends HTMLElement {
	setState(key_path: string, value: unknown): void
	getState(key_path: string): unknown
}

interface ListRenderingContext {
	states: Record<string, unknown>
	stateToElementsMap: Record<string, Set<HTMLElement>>
	statesListeners: Record<string, (value: unknown) => void>
	setState: (keyPath: string, value: unknown) => void
	getState: (keyPath: string) => unknown
	triggerFunc: (eventName: string, ...args: unknown[]) => void
}

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
