// Annotation store: user feedback pinned to elements. Persisted to
// <root>/.insider/annotations.json so notes survive dev-server restarts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type NoteAnchor = {
  ref?: string;                       // live ref at creation time (session-scoped)
  component?: string;
  src?: string;                       // canonical source ref
  text?: string;                      // element's own text snippet
  box?: { x: number; y: number; w: number; h: number };
  orphaned?: boolean;                 // set by the client when re-anchoring fails
};

export type Note = {
  id: string;
  text: string;
  state: "open" | "done";
  resolution?: string;
  page: string;                       // url pathname the note was made on
  elements: NoteAnchor[];
  createdAt: number;
  resolvedAt?: number;
};

export class NoteStore {
  private notes = new Map<string, Note>();
  private next = 1;

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { next: number; notes: Note[] };
        this.next = data.next;
        for (const n of data.notes) this.notes.set(n.id, n);
      } catch { /* corrupt file -> start fresh, never crash the dev server */ }
    }
  }

  list(page?: string): Note[] {
    const all = [...this.notes.values()];
    return page ? all.filter((n) => n.page === page) : all;
  }

  create(text: string, elements: NoteAnchor[], page: string): Note {
    const n: Note = { id: "n" + this.next++, text, state: "open", page, elements, createdAt: Date.now() };
    this.notes.set(n.id, n);
    this.save();
    return n;
  }

  update(id: string, text: string): Note | null {
    const n = this.notes.get(id);
    if (!n) return null;
    n.text = text;
    this.save();
    return n;
  }

  done(id: string, resolution?: string): Note | null {
    const n = this.notes.get(id);
    if (!n) return null;
    n.state = "done";
    n.resolvedAt = Date.now();
    if (resolution) n.resolution = resolution;
    this.save();
    return n;
  }

  rm(id: string): boolean {
    const hit = this.notes.delete(id);
    if (hit) this.save();
    return hit;
  }

  clear(): number {
    const count = this.notes.size;
    this.notes.clear();
    this.save();
    return count;
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ next: this.next, notes: [...this.notes.values()] }, null, 1));
  }
}
