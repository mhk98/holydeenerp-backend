import { sendCreated, sendPaginated, sendSuccess } from '../../utils/apiResponse.js';
import * as rolesService from './roles.service.js';

export async function catalog(req, res) {
  return sendSuccess(res, { data: await rolesService.getCatalog() });
}

export async function list(req, res) {
  const { rows, count, page, limit } = await rolesService.listRoles(req.auth, req.query);
  return sendPaginated(res, { rows, count }, { page, limit });
}

export async function get(req, res) {
  return sendSuccess(res, { data: await rolesService.getRole(req.auth, req.validated.params.id) });
}

export async function create(req, res) {
  return sendCreated(res, await rolesService.createRole(req.auth, req.validated.body), 'Role created');
}

export async function update(req, res) {
  const data = await rolesService.updateRole(req.auth, req.validated.params.id, req.validated.body);
  return sendSuccess(res, { data, message: 'Role updated' });
}

export async function setPermissions(req, res) {
  const { permissionKeys } = req.validated.body;
  const data = await rolesService.setPermissions(req.auth, req.validated.params.id, permissionKeys);
  return sendSuccess(res, { data, message: 'Permissions saved' });
}

export async function remove(req, res) {
  await rolesService.deleteRole(req.auth, req.validated.params.id);
  return sendSuccess(res, { message: 'Role deleted' });
}
