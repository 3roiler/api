import { Router } from 'express';
import userController from '../controllers/userController.js';

const router = Router();

/**
 * @route   GET /users
 * @desc    Get all users
 * @access  Protected
 */
router.get('/', userController.getAllUsers);

/**
 * @route   GET /users/:id
 * @desc    Get user by ID
 * @access  Protected
 */
router.get('/:id', userController.getUserById);

/**
 * @route   POST /users
 * @desc    Create new user
 * @access  Protected
 */
router.post('/', userController.createUser);

/**
 * @route   PUT /users/:id
 * @desc    Update user
 * @access  Protected
 */
router.put('/:id', userController.updateUser);

/**
 * @route   DELETE /users/:id
 * @desc    Delete user
 * @access  Protected
 */
router.delete('/:id', userController.deleteUser);

export default router;
