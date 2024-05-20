export interface Project {
  name: string;
  author: string;
  topModule: string;
  sources: Record<string, string>;
}
