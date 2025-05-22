export default function triggerDomUpdates(
	keyPath: string,
	ops: {
		stateToElementsMap: Record<string, Set<HTMLElement>>
		scheduleUpdate: (elements: Set<HTMLElement>) => void
		textBindings:
			| Array<{
					node: Text
					expr: string
					originalContent: string
			  }>
			| undefined
		attributeBindings:
			| Array<{
					element: Element
					attrName: string
					expr: string
					template: string
			  }>
			| undefined
		updateTextNode: (node: Text, expr: string, template: string) => void
		getNestedState: (path: string) => unknown
	},
) {
	if (ops.stateToElementsMap[keyPath]) {
		const updateQueue = new Set<HTMLElement>()

		for (const element of ops.stateToElementsMap[keyPath]) {
			updateQueue.add(element)
		}

		ops.scheduleUpdate(updateQueue)
	}

	// Update text bindings that depend on this state
	if (ops.textBindings) {
		// this._textBindings.forEach((binding) => {
		for (const binding of ops.textBindings) {
			if (binding.expr === keyPath || binding.expr.startsWith(`${keyPath}.`)) {
				ops.updateTextNode(binding.node, binding.expr, binding.originalContent)
			}
		}
	}

	// Update attribute bindings that depend on this state
	if (ops.attributeBindings) {
		for (const binding of ops.attributeBindings) {
			if (binding.expr === keyPath || binding.expr.startsWith(`${keyPath}.`)) {
				const value = ops.getNestedState(binding.expr)
				if (value !== undefined) {
					binding.element.setAttribute(binding.attrName, String(value))
				}
			}
		}
	}
}
