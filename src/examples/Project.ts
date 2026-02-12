export interface Project {
  id: string;
  name: string;
  author: string;
  sources: Record<string, string>;
  dataFiles?: Record<string, string>;
}
