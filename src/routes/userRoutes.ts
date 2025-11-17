import { Router } from 'express';
import userController from '../controllers/userController';

const router = Router();

/**
 * @route   GET /users
 * @desc    Get all users
 * @access  Public
 */
router.get('/', userController.getAllUsers);

/**
 * @route   GET /users/:id
 * @desc    Get user by ID
 * @access  Public
 */
router.get('/:id', userController.getUserById);

/**
 * @route   POST /users
 * @desc    Create new user
 * @access  Public
 */
router.post('/', userController.createUser);

/**
 * @route   PUT /users/:id
 * @desc    Update user
 * @access  Public
 */
router.put('/:id', userController.updateUser);

/**
 * @route   DELETE /users/:id
 * @desc    Delete user
 * @access  Public
 */
router.delete('/:id', userController.deleteUser);

export default router;
