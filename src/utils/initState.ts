import triggerDomUpdates from './triggerDomUpdates'

export default function initState(
	ops: {
		stateToElementsMap: Record<string, Set<HTMLElement>>
		textBindings: Array<{
			node: Text
			expr: string
			originalContent: string
		}>
		attributeBindings: Array<{
			element: Element
			attrName: string
			expr: string
			template: string
		}>
		updateTextNode: (node: Text, value: string) => void
		getNestedState: (keyPath: string) => unknown
		scheduleUpdate: (elements: Set<HTMLElement>) => void
		conditionalElements: Map<
			Element,
			{
				expr: string
				placeholder: Comment
				isPresent: boolean
			}
		>
		evaluateIfCondition: (element: Element, expr: string) => void
		currentRenderingElement?: HTMLElement
		statesListenersSelf: Record<string, (...args: unknown[]) => void>
	},
	states?: Record<string, unknown>,
	statesListeners?: { [key: string]: (value: unknown) => void } | undefined,
) {
	console.log(states)
	// copy state from options
	return new Proxy(
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
				triggerDomUpdates(keyPath, {
					stateToElementsMap: ops.stateToElementsMap,
					textBindings: ops.textBindings,
					attributeBindings: ops.attributeBindings,
					updateTextNode: ops.updateTextNode,
					getNestedState: ops.getNestedState,
					scheduleUpdate: ops.scheduleUpdate,
				})
				if (ops.statesListenersSelf[keyPath])
					ops.statesListenersSelf[keyPath](value)

				// trigger %if macros
				if (ops.conditionalElements.size > 0)
					ops.conditionalElements.forEach((info, element) => {
						if (info.expr.includes(keyPath))
							ops.evaluateIfCondition(element, info.expr)
					})

				// trigger state update events
				statesListeners?.[keyPath]?.(value)

				return true
			},
			get: (target: Record<string, unknown>, keyPath: string) => {
				// collect state dependencies
				if (ops.currentRenderingElement) {
					if (!ops.stateToElementsMap[keyPath])
						ops.stateToElementsMap[keyPath] = new Set()
					ops.stateToElementsMap[keyPath].add(ops.currentRenderingElement)
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
