import { defineConfig } from 'vite';
export default defineConfig({build:{outDir:'wwwroot/assets',emptyOutDir:true,lib:{entry:'game.js',formats:['es'],fileName:()=> 'game.js'}}});
