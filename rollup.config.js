import resolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import typescript from '@rollup/plugin-typescript'
import dts from 'rollup-plugin-dts'

export default [
	{
		input: 'src/main.ts',
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
		input: 'dist/utils/index.js',
		output: {
			file: 'dist/utils.bundle.min.js',
			format: 'esm',
			inlineDynamicImports: true,
			plugins: [terser()],
		},
		plugins: [resolve(), typescript({ outDir: 'dist' })],
	},
	{
		input: 'dist/types/main.d.ts',
		output: {
			file: 'dist/types/main.d.ts',
			format: 'es',
		},
		plugins: [dts()],
	},
]
