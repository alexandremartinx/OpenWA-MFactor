import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Loads the assistant's static instructions — the system prompt file plus every Markdown file of the
 * knowledge directory — into one system message.
 *
 * The result is the stable PREFIX of every request, deliberately: OpenAI caches the longest
 * repeated prompt prefix, so the whole knowledge base is billed at the cached rate after the first
 * reply, while everything that changes per chat goes in a later message.
 *
 * Re-read when any file's mtime or the file set changes, so an operator editing the knowledge base
 * does not need a restart; otherwise served from memory.
 */
export class AiBotInstructions {
  private cache?: { signature: string; text: string };

  constructor(
    private readonly systemPromptFile: string | null,
    private readonly knowledgeDir: string | null,
  ) {}

  /** The instructions, or null when neither source is configured or readable. */
  async load(): Promise<string | null> {
    const files = await this.listFiles();
    if (files.length === 0) return null;

    const stats = await Promise.all(files.map(async file => ({ file, mtimeMs: (await fs.stat(file.path)).mtimeMs })));
    const signature = stats.map(({ file, mtimeMs }) => `${file.path}:${mtimeMs}`).join('|');
    if (this.cache?.signature === signature) return this.cache.text;

    let prompt: string | null = null;
    const documents: string[] = [];
    for (const file of files) {
      const content = (await fs.readFile(file.path, 'utf8')).trim();
      if (!content) continue;
      if (file.kind === 'prompt') prompt = content;
      else documents.push(`<documento nome="${file.name}">\n${content}\n</documento>`);
    }
    const text = [
      prompt,
      documents.length
        ? '# BASE DE CONHECIMENTO\n\n' +
          'Os documentos abaixo são a sua base de conhecimento e a única fonte de fatos sobre o produto. ' +
          'Regras de comportamento que aparecem neles valem junto com as instruções acima.\n\n' +
          documents.join('\n\n')
        : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');

    this.cache = { signature, text };
    return text || null;
  }

  private async listFiles(): Promise<Array<{ kind: 'prompt' | 'knowledge'; name: string; path: string }>> {
    const files: Array<{ kind: 'prompt' | 'knowledge'; name: string; path: string }> = [];
    if (this.systemPromptFile) {
      const path = resolve(this.systemPromptFile);
      if (await isFile(path)) files.push({ kind: 'prompt', name: path, path });
    }
    if (this.knowledgeDir) {
      const dir = resolve(this.knowledgeDir);
      const names = await fs.readdir(dir).catch((): string[] => []);
      for (const name of names.filter(isKnowledgeFile).sort()) {
        const path = join(dir, name);
        if (await isFile(path)) files.push({ kind: 'knowledge', name, path });
      }
    }
    return files;
  }
}

/**
 * Markdown files except `README.md`, which in a knowledge base is the maintainer's notes — how to
 * load the files, known product gaps — and must not reach the assistant.
 */
export function isKnowledgeFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md';
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}
