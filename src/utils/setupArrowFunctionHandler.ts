export default function setupArrowFunctionHandler(
	element: Element,
	eventName: string,
	handlerValue: string,
	ops: {
		createHandlerContext: (
			event: Event,
			element: Element,
		) => {
			states: Record<string, unknown>
			stateToElementsMap: Record<string, Set<HTMLElement>>
			statesListeners: Record<string, (value: unknown) => void>
			setState: (keyPath: string, value: unknown) => void
			getState: (keyPath: string) => unknown
			triggerFunc: (eventName: string, ...args: unknown[]) => void
		}
	},
) {
	element.addEventListener(eventName, (event: Event) => {
		try {
			// Arrow function parsing
			const splitted = handlerValue.split('=>')
			if (splitted.length !== 2) {
				throw new Error(`Invalid arrow function syntax: ${handlerValue}`)
			}
			const paramsStr = (() => {
				if (splitted[0].includes('(')) return splitted[0].trim()
				return `(${splitted[0].trim()})`
			})()
			const bodyStr = splitted[1].trim()

			// Check if the function body is wrapped in {}
			const isMultiline = bodyStr.startsWith('{') && bodyStr.endsWith('}')

			// If it is a multiline function body, remove the outer braces
			if (isMultiline) {
				// Remove the outer braces
				let bodyStr = handlerValue.split('=>')[1].trim()
				bodyStr = bodyStr.substring(1, bodyStr.length - 1)

				// Build code for multiline arrow function
				const functionCode = `
									return function${paramsStr} {
										${bodyStr}
									}
								`

				// Create context object
				const context = ops.createHandlerContext(event, element)

				// Create and call function
				const handlerFn = new Function(functionCode).call(null)
				handlerFn.apply(context, [event])
			} else {
				// Single line arrow function, directly return expression result
				const functionCode = `
									return function${paramsStr} {
										return ${bodyStr}
									}
								`

				// Create context object
				const context = ops.createHandlerContext(event, element)

				// Create and call function
				const handlerFn = new Function(functionCode).call(null)
				handlerFn.apply(context, [event])
			}
		} catch (err) {
			console.error(
				`Error executing arrow function handler: ${handlerValue}`,
				err,
			)
		}
	})
}
