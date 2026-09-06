import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

marked.use(markedTerminal());
console.log(marked.parse('```js\nconst a = 1;\n```'));
