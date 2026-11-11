import '@fontsource/chakra-petch/latin-400.css';
import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import './ui/style.css';
import { createEngine } from './audio/engine.js';
import { mountApp } from './ui/app.js';

const engine = createEngine();
mountApp(document.getElementById('app'), engine);
