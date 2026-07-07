import { AppError } from '../lib/errors.js';

// Bound the outbound Google Books lookup so a slow/unreachable googleapis.com
// cannot stall the synchronous POST /books/upload request path. Matches the
// AbortSignal.timeout convention in mathpix.service.ts and knowledge-base.service.ts.
const GOOGLE_BOOKS_TIMEOUT_MS = 15_000;

interface BookMetadata {
  title: string;
  author?: string;
  description?: string;
  coverUrl?: string;
  isbn?: string;
  publisher?: string;
  publishYear?: number;
  categories?: string[];
  language?: string;
}

export const metadataService = {
  async lookupGoogleBooks(title: string, author?: string): Promise<BookMetadata | null> {
    try {
      let query = encodeURIComponent(title);
      if (author) query += '+inauthor:' + encodeURIComponent(author);

      const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${query}&maxResults=1`, {
        signal: AbortSignal.timeout(GOOGLE_BOOKS_TIMEOUT_MS),
      });
      if (!res.ok) return null;

      const data = await res.json();
      if (!data.items || data.items.length === 0) return null;

      const vol = data.items[0].volumeInfo;
      return {
        title: vol.title ?? title,
        author: vol.authors?.join(', '),
        description: vol.description,
        coverUrl: vol.imageLinks?.thumbnail?.replace('http:', 'https:'),
        isbn: vol.industryIdentifiers?.find((i: any) => i.type === 'ISBN_13')?.identifier
          ?? vol.industryIdentifiers?.[0]?.identifier,
        publisher: vol.publisher,
        publishYear: vol.publishedDate ? parseInt(vol.publishedDate) : undefined,
        categories: vol.categories,
        language: vol.language,
      };
    } catch {
      return null;
    }
  },
};
