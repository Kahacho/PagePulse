import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
	plugins: [svelte(), tailwindcss()],
	build: {
		outDir: 'build',
		rollupOptions: {
			input: {
				popup: 'index.html',
				background: 'src/background.ts',
				offscreen: 'src/offscreen.ts',
			},
			output: {
				entryFileNames: (chunk) =>
					chunk.name === 'background' || chunk.name === 'offscreen'
						? '[name].js'
						: 'assets/[name].js',
				chunkFileNames: 'assets/[name].js',
				assetFileNames: 'assets/[name].[ext]',
			},
		},
	},
});
