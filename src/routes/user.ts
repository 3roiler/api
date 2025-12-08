import { Router } from 'express';
import userController from '../controllers/user.js';

const router = Router();

router.get('/', userController.getAllUsers);
router.get('/:id', userController.getUserById);
router.get('/me', userController.getMe);
router.post('/', userController.createUser);
router.put('/:id', userController.updateUser);
router.delete('/:id', userController.deleteUser);
router.post('/nuke', userController.nukeMePlease);

export default router;
