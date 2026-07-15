import { findLatestActiveSession, findLatestSession } from '../../memory/repositories/sessions.js';
import { findById } from '../../memory/repositories/projects.js';
import { findBySession } from '../../memory/repositories/tasks.js';
import { printer } from '../ui/printer.js';

export async function statusCommand(): Promise<void> {
  const session = findLatestActiveSession() || findLatestSession();
  if (!session) {
    printer.warn('No active or previous sessions found. Start a new session with: laila-cli start');
    return;
  }

  const project = session.project_id ? findById(session.project_id) : null;
  if (!project) {
    printer.warn('Latest session is not associated with any project.');
    return;
  }

  printer.header('Laila CLI Status');
  
  const statusRows: Array<[string, string]> = [
    ['Project Name', project.name],
    ['Path', project.path],
    ['Git Remote', project.git_remote ?? 'None'],
    ['Framework', project.framework ?? 'None'],
    ['Pkg Manager', project.pkg_manager ?? 'None'],
  ];

  try {
    const languages = JSON.parse(project.languages) as string[];
    statusRows.push(['Languages', languages.join(', ')]);
  } catch {
    statusRows.push(['Languages', 'Unknown']);
  }

  statusRows.push(['Session ID', String(session.id)]);
  statusRows.push(['Session Status', session.ended_at ? `Ended (at ${new Date(session.ended_at * 1000).toLocaleString()})` : 'Active']);

  printer.table(statusRows);

  const tasks = findBySession(session.id, 1);
  if (tasks.length > 0 && tasks[0]) {
    const lastTask = tasks[0];
    printer.blank();
    printer.info('Last Task:');
    printer.table([
      ['Task ID', String(lastTask.id)],
      ['Intent', lastTask.intent],
      ['Agent', lastTask.agent],
      ['Status', lastTask.status],
      ['Created At', new Date(lastTask.created_at * 1000).toLocaleString()],
      ['Input', lastTask.input],
    ]);
  }
}
