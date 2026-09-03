import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// Entry point for the popup. Vite loads this directly via the <script>
// tag in index.html, so there's nothing else to wire up here.
mount(App, {
	target: document.getElementById('app')!,
});
