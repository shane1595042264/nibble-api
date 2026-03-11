import { bookRepository } from '../repositories/book.repository.js';
import { Errors } from '../lib/errors.js';

export const bookService = {
  async listBooks(userId: string) {
    return bookRepository.findByUserId(userId);
  },

  async getBook(id: string, userId: string) {
    const book = await bookRepository.findById(id);
    if (!book || book.userId !== userId) throw Errors.notFound('Book');
    return book;
  },

  async createBook(userId: string, data: { catalogId: string; customTitle?: string; coverUrl?: string }) {
    const existing = await bookRepository.findByUserIdAndCatalogId(userId, data.catalogId);
    if (existing) throw Errors.duplicateBook();
    return bookRepository.create({ ...data, userId });
  },

  async updateBook(id: string, userId: string, data: Record<string, unknown>) {
    const book = await this.getBook(id, userId);
    return bookRepository.update(book.id, data);
  },

  async deleteBook(id: string, userId: string) {
    const book = await this.getBook(id, userId);
    return bookRepository.softDelete(book.id);
  },
};
