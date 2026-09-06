import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';

marked.setOptions({ renderer: new TerminalRenderer() });
console.log(marked.parse('```js\nconst a = 1;\n```'));
