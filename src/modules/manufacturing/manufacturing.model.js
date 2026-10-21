import { DataTypes } from 'sequelize';
import { sequelize } from '../../config/db.js';
import { baseModelOptions, idColumn, money, quantity, tenantColumns } from '../../utils/model.js';

export const BOM_STATUSES = ['draft', 'active', 'archived'];
export const MO_STATUSES = [
  'draft',
  'confirmed',
  'material_issued',
  'in_progress',
  'quality_check',
  'completed',
  'closed',
  'cancelled',
];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const id = (allowNull = true) => ({ type: DataTypes.BIGINT.UNSIGNED, allowNull });
// Factories: Sequelize writes into attribute definitions, so models must not share one object.
const minutes = () => ({ type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: '0' });
const percent = () => ({ type: DataTypes.DECIMAL(7, 4), allowNull: false, defaultValue: '0' });
const lineOptions = (tableName) => ({ tableName, underscored: true, timestamps: true });
const item = () => ({ productId: id(false), variantId: id() });
const by = (...names) =>
  Object.fromEntries(
    names.flatMap((n) => [
      [`${n}By`, id()],
      [`${n}At`, DataTypes.DATE],
    ]),
  );

export const WorkCenter = sequelize.define(
  'WorkCenter',
  {
    ...idColumn,
    ...tenantColumns(),
    code: { type: DataTypes.STRING(30), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    /** Working hours per day. */
    capacityHours: { type: DataTypes.DECIMAL(6, 2), allowNull: false, defaultValue: '8' },
    labourCostPerHour: money(),
    overheadCostPerHour: money(),
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    notes: DataTypes.STRING(500),
  },
  { ...baseModelOptions, tableName: 'work_centers' },
);

export const Bom = sequelize.define(
  'Bom',
  {
    ...idColumn,
    ...tenantColumns({ branch: false }),
    ...item(),
    code: { type: DataTypes.STRING(40), allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    /** Output quantity (base unit) the components make. */
    quantity: quantity(),
    status: { type: DataTypes.ENUM(...BOM_STATUSES), allowNull: false, defaultValue: 'draft' },
    isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    notes: DataTypes.TEXT,
    ...by('activated'),
  },
  { ...baseModelOptions, tableName: 'boms' },
);

export const BomComponent = sequelize.define(
  'BomComponent',
  {
    ...idColumn,
    bomId: id(false),
    ...item(),
    unitId: id(),
    unitFactor: { type: DataTypes.DECIMAL(18, 6), allowNull: false, defaultValue: '1' },
    quantity: quantity(),
    baseQuantity: quantity(),
    wastagePercent: percent(),
    notes: DataTypes.STRING(255),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  lineOptions('bom_components'),
);

export const BomByproduct = sequelize.define(
  'BomByproduct',
  {
    ...idColumn,
    bomId: id(false),
    ...item(),
    quantity: quantity(),
    costSharePercent: percent(),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  lineOptions('bom_byproducts'),
);

export const BomOperation = sequelize.define(
  'BomOperation',
  {
    ...idColumn,
    bomId: id(false),
    sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
    name: { type: DataTypes.STRING(150), allowNull: false },
    workCenterId: id(false),
    setupMinutes: minutes(),
    /** Minutes to make the BOM's output quantity. */
    runMinutes: minutes(),
    notes: DataTypes.STRING(255),
  },
  lineOptions('bom_operations'),
);

export const BomQualityCheck = sequelize.define(
  'BomQualityCheck',
  {
    ...idColumn,
    bomId: id(false),
    sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
    name: { type: DataTypes.STRING(150), allowNull: false },
    instructions: DataTypes.STRING(500),
  },
  lineOptions('bom_quality_checks'),
);

export const ManufacturingOrder = sequelize.define(
  'ManufacturingOrder',
  {
    ...idColumn,
    ...tenantColumns(),
    branchId: id(false),
    number: { type: DataTypes.STRING(60), allowNull: false },
    ...item(),
    bomId: id(false),
    parentId: id(),
    salesOrderId: id(),
    salesOrderItemId: id(),
    rawWarehouseId: id(false),
    finishedWarehouseId: id(false),
    quantity: quantity(),
    producedQuantity: quantity(),
    goodQuantity: quantity(),
    scrappedQuantity: quantity(),
    status: { type: DataTypes.ENUM(...MO_STATUSES), allowNull: false, defaultValue: 'draft' },
    priority: { type: DataTypes.ENUM(...PRIORITIES), allowNull: false, defaultValue: 'normal' },
    plannedStart: { type: DataTypes.DATEONLY, allowNull: false },
    plannedEnd: { type: DataTypes.DATEONLY, allowNull: false },
    actualStart: DataTypes.DATE,
    actualEnd: DataTypes.DATE,
    stdMaterialCost: money(),
    stdLabourCost: money(),
    stdOverheadCost: money(),
    materialCost: money(),
    labourCost: money(),
    overheadCost: money(),
    outputCost: money(),
    varianceCost: money(),
    unitCost: money(),
    notes: DataTypes.TEXT,
    ...by('confirmed', 'completed', 'closed', 'cancelled'),
  },
  { ...baseModelOptions, tableName: 'manufacturing_orders' },
);

export const MoMaterial = sequelize.define(
  'MoMaterial',
  {
    ...idColumn,
    orderId: id(false),
    ...item(),
    requiredQuantity: quantity(),
    issuedQuantity: quantity(),
    returnedQuantity: quantity(),
    cost: money(),
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  lineOptions('mo_materials'),
);

export const MoOperation = sequelize.define(
  'MoOperation',
  {
    ...idColumn,
    orderId: id(false),
    sequence: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 10 },
    name: { type: DataTypes.STRING(150), allowNull: false },
    workCenterId: id(false),
    plannedMinutes: minutes(),
    actualMinutes: minutes(),
    status: {
      type: DataTypes.ENUM('pending', 'in_progress', 'done'),
      allowNull: false,
      defaultValue: 'pending',
    },
    startedAt: DataTypes.DATE,
    finishedAt: DataTypes.DATE,
    labourCost: money(),
    overheadCost: money(),
  },
  lineOptions('mo_operations'),
);

export const MoOutput = sequelize.define(
  'MoOutput',
  {
    ...idColumn,
    orderId: id(false),
    kind: { type: DataTypes.ENUM('product', 'byproduct'), allowNull: false },
    ...item(),
    warehouseId: id(false),
    batchId: id(),
    quantity: quantity(),
    unitCost: money(),
    totalCost: money(),
    outputDate: { type: DataTypes.DATEONLY, allowNull: false },
  },
  lineOptions('mo_outputs'),
);

export const MoScrap = sequelize.define(
  'MoScrap',
  {
    ...idColumn,
    orderId: id(false),
    ...item(),
    quantity: quantity(),
    cost: money(),
    reason: { type: DataTypes.STRING(255), allowNull: false },
    recordedBy: id(),
  },
  lineOptions('mo_scrap'),
);

export const QualityCheck = sequelize.define(
  'QualityCheck',
  {
    ...idColumn,
    orderId: id(false),
    name: { type: DataTypes.STRING(150), allowNull: false },
    result: { type: DataTypes.ENUM('pass', 'fail'), allowNull: false },
    passedQuantity: quantity(),
    failedQuantity: quantity(),
    action: { type: DataTypes.ENUM('accept', 'scrap', 'rework'), allowNull: false, defaultValue: 'accept' },
    reason: DataTypes.STRING(500),
    checkedBy: id(),
    checkedAt: { type: DataTypes.DATE, allowNull: false },
  },
  lineOptions('quality_checks'),
);
