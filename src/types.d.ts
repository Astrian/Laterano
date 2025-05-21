interface CustomElement extends HTMLElement {
	setState(key_path: string, value: unknown): void
	getState(key_path: string): unknown
}
