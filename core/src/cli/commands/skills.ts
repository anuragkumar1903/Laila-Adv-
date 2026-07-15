import { discoverSkills } from '../../skills/skill-loader.js';
import { printer } from '../ui/printer.js';
import { spinner } from '../ui/spinner.js';

export async function skillsCommand(): Promise<void> {
  spinner.start('Scanning available skills…');
  const skills = await discoverSkills();
  spinner.succeed('Skills discovered');

  if (skills.length === 0) {
    printer.warn('No skills found in the skills directory.');
    return;
  }

  printer.header('Discovered Skills');
  printer.table(skills.map(skill => [
    skill.name,
    `${skill.agent}  •  ${skill.path.replace(/\\/g, '/')}`,
  ]));
}