import resolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'

export default [
	{
		input: 'dist/main.js',
		output: [
			{
				file: 'dist/main.min.js',
				format: 'esm',
				plugins: [terser()],
			},
		],
		plugins: [resolve(), typescript()],
	},
	{
		input: 'dist/types/main.d.ts',
		output: {
			file: 'dist/types.d.ts',
			format: 'es',
		},
		plugins: [dts()],
	},
]
