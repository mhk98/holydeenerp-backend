import { Router } from 'express';
import healthRoutes from './modules/health/health.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import rolesRoutes from './modules/roles/roles.routes.js';
import branchesRoutes from './modules/branches/branches.routes.js';
import settingsRoutes from './modules/settings/settings.routes.js';
import {
  attributesRouter,
  brandsRouter,
  categoriesRouter,
  productsRouter,
} from './modules/products/products.routes.js';
import {
  customerGroupsRouter,
  customersRouter,
  supplierGroupsRouter,
  suppliersRouter,
} from './modules/parties/parties.routes.js';
import inventoryRoutes from './modules/inventory/inventory.routes.js';
import purchaseRoutes from './modules/purchase/purchase.routes.js';
import posRoutes from './modules/pos/pos.routes.js';
import salesRoutes from './modules/sales/sales.routes.js';
import accountingRoutes from './modules/accounting/accounting.routes.js';
import manufacturingRoutes from './modules/manufacturing/manufacturing.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';

/** Mounts every module under /api/v1. Register new modules here. */
const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', usersRoutes);
router.use('/roles', rolesRoutes);
router.use('/branches', branchesRoutes);
router.use('/settings', settingsRoutes);
router.use('/products', productsRouter);
router.use('/product-categories', categoriesRouter);
router.use('/brands', brandsRouter);
router.use('/product-attributes', attributesRouter);
router.use('/customers', customersRouter);
router.use('/suppliers', suppliersRouter);
router.use('/customer-groups', customerGroupsRouter);
router.use('/supplier-groups', supplierGroupsRouter);
router.use('/inventory', inventoryRoutes);
router.use('/purchase', purchaseRoutes);
router.use('/sales', salesRoutes);
router.use('/pos', posRoutes);
router.use('/accounting', accountingRoutes);
router.use('/manufacturing', manufacturingRoutes);
router.use('/dashboard', dashboardRoutes);

export default router;
