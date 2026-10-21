import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import * as usersService from './users.service.js';

export async function list(req, res) {
  const { rows, count, page, limit } = await usersService.listUsers(req.auth, req.validated.query);
  return sendPaginated(res, { rows, count }, { page, limit });
}

export async function get(req, res) {
  return sendSuccess(res, { data: await usersService.getUser(req.auth, req.validated.params.id) });
}

export async function create(req, res) {
  return sendCreated(res, await usersService.createUser(req.auth, req.validated.body), 'User created');
}

export async function update(req, res) {
  const data = await usersService.updateUser(req.auth, req.validated.params.id, req.validated.body);
  return sendSuccess(res, { data, message: 'User updated' });
}

export async function setStatus(req, res) {
  const { status } = req.validated.body;
  const data = await usersService.setStatus(req.auth, req.validated.params.id, status);
  return sendSuccess(res, { data, message: status === 'active' ? 'User activated' : 'User deactivated' });
}

export async function remove(req, res) {
  await usersService.deleteUser(req.auth, req.validated.params.id);
  return sendSuccess(res, { message: 'User deleted' });
}
