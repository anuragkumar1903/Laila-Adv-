import type { ToolDefinition } from '../llm/providers/base.js';

export function getNativeTools(): ToolDefinition[] {
  return [
    {
      name: 'read_file',
      description: 'Reads the contents of one or more files. Use this to examine existing code.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of relative or absolute file paths to read.'
          }
        },
        required: ['files']
      }
    },
    {
      name: 'write_file',
      description: 'Creates a new file or completely overwrites an existing file.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'The relative or absolute path of the file to write.'
          },
          content: {
            type: 'string',
            description: 'The complete file content to write.'
          }
        },
        required: ['file', 'content']
      }
    },
    {
      name: 'patch_file',
      description: 'Modifies an existing file by searching for an exact block of text and replacing it.',
      parameters: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'The relative or absolute path of the file to patch.'
          },
          find: {
            type: 'string',
            description: 'The exact text to find in the file. Must match formatting and indentation perfectly.'
          },
          replace: {
            type: 'string',
            description: 'The text to replace the found text with.'
          }
        },
        required: ['file', 'find', 'replace']
      }
    },
    {
      name: 'grep_search',
      description: 'Searches for a regex or string pattern across files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The search pattern or text to find.'
          },
          path: {
            type: 'string',
            description: 'Directory or file to search within (e.g. "src" or ".").'
          }
        },
        required: ['pattern']
      }
    },
    {
      name: 'run_command',
      description: 'Executes a shell command in the workspace. Use for npm install, running tests, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run.'
          }
        },
        required: ['command']
      }
    },
    {
      name: 'git_command',
      description: 'Executes a git command. Supported actions: status, log, branch, checkout, add, commit, diff, etc.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The git action (e.g. status, commit, add)'
          },
          args: {
            type: 'string',
            description: 'Arguments for the git action (e.g. "-m \'Message\'" or ".")'
          }
        },
        required: ['action']
      }
    },
    {
      name: 'browser_action',
      description: 'Interacts with a webpage (e.g. localhost) to take a screenshot or extract HTML.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to visit'
          },
          action: {
            type: 'string',
            description: 'The action to perform: "screenshot", "text", or "html"'
          }
        },
        required: ['url', 'action']
      }
    },
    {
      name: 'web_search',
      description: 'Searches the web for current information, documentation, or news.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query.'
          }
        },
        required: ['query']
      }
    },
    {
      name: 'web_read_url',
      description: 'Extracts the full markdown text from a specific webpage URL.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to extract text from.'
          }
        },
        required: ['url']
      }
    }
  ];
}
