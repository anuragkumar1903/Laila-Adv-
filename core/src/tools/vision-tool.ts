import { readFile } from 'fs/promises';
import { loadProviderConfig } from '../config/config-loader.js';

export async function askVision(projectPath: string, imagePath: string, prompt: string): Promise<string> {
  const config = await loadProviderConfig(projectPath);
  if (!config || !config.apiKey) {
    throw new Error('Gemini API key is required for vision capabilities. Please configure it.');
  }

  const imageBuf = await readFile(imagePath);
  const base64Data = imageBuf.toString('base64');
  let mimeType = 'image/jpeg';
  if (imagePath.endsWith('.png')) mimeType = 'image/png';
  if (imagePath.endsWith('.webp')) mimeType = 'image/webp';

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${config.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data
            }
          }
        ]
      }]
    })
  });

  if (!res.ok) {
    throw new Error(`Vision API failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Vision model.';
}
