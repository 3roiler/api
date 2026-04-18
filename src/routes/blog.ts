import { Router } from 'express';
import { system } from '../services/index.js';
import blogController from '../controllers/blog.js';
import requirePermission from '../middleware/requirePermission.js';

const router = Router();

// Public reads. `authHandler`-as-optional would be cleaner but the current
// implementation hard-rejects unauthenticated requests, so the public routes
// skip it and `includeDrafts` falls back to false for non-authors.
router.get('/', blogController.listPosts);
router.get('/:slug', blogController.getPostBySlug);

// Write routes require auth + blog.write.
const writeGate = [system.authHandler, requirePermission('blog.write')];

router.post('/', ...writeGate, blogController.createPost);
router.put('/:id', ...writeGate, blogController.updatePost);
router.delete('/:id', ...writeGate, blogController.deletePost);

export default router;
