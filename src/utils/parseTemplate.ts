export default function parseTemplate(template: string): Element {
	const parser = new DOMParser()
	const doc = parser.parseFromString(template, 'text/html')

	const mainContent = doc.body.firstElementChild
	let rootElement: Element

	if (mainContent) {
		rootElement = document.importNode(mainContent, true)
	} else {
		const container = document.createElement('div')
		container.innerHTML = template
		rootElement = container
	}

	return rootElement
}
