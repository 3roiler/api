import { Router } from 'express';
import { system } from '../services/index.js';
import blogController from '../controllers/blog.js';
import requirePermission from '../middleware/requirePermission.js';

const router = Router();

// Public reads — `optionalAuthHandler` decodes the session cookie if present
// (so authors get drafts) but does not 401 anonymous visitors.
router.get('/', system.optionalAuthHandler, blogController.listPosts);
router.get('/:slug', system.optionalAuthHandler, blogController.getPostBySlug);

// Write routes require auth + blog.write.
const writeGate = [system.authHandler, requirePermission('blog.write')];

router.post('/', ...writeGate, blogController.createPost);
router.put('/:id', ...writeGate, blogController.updatePost);
router.delete('/:id', ...writeGate, blogController.deletePost);

export default router;
