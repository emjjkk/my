import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

export interface PostMeta {
  slug: string;
  title: string;
  date: string;
}

export interface Post extends PostMeta {
  content: string;
}

const postsDir = path.join(process.cwd(), 'src/data/p');

export function getAllPosts(): PostMeta[] {
  const files = fs.readdirSync(postsDir);

  const posts = files
    .filter((f) => f.endsWith('.mdx'))
    .map((file) => {
      const slug = file.replace(/\.mdx$/, '');
      const content = fs.readFileSync(path.join(postsDir, file), 'utf-8');
      const { data } = matter(content);
      return { slug, ...(data as { title: string; date: string }) };
    });

  return posts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function getPostBySlug(slug: string): Post {
  const fullPath = path.join(postsDir, `${slug}.mdx`);
  if (!fs.existsSync(fullPath)) throw new Error(`Post not found: ${slug}`);
  const source = fs.readFileSync(fullPath, 'utf-8');
  const { data, content } = matter(source);
  return { slug, ...(data as { title: string; date: string }), content };
}
