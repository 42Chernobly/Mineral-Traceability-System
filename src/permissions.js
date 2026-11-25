/** Roles, stop types and the chain-of-custody event rules (RBAC). */

const ROLES = ['admin', 'mine', 'transporter', 'weighbridge', 'inspector', 'regulator', 'buyer', 'border', 'port'];

const ROLE_LABELS = {
  admin: 'System Administrator',
  mine: 'Mine Operator',
  transporter: 'Transporter',
  weighbridge: 'Weighbridge / Checkpoint Officer',
  inspector: 'Inspector',
  regulator: 'Regulator (ZRA / Mines)',
  buyer: 'Buyer / Exporter',
  border: 'Border / Customs Officer',
  port: 'Port Operator',
};

// A stop's type decides the role of everyone who signs up at it. Privileged roles
// (admin, regulator, buyer) can never be obtained by self sign-up.
const STOP_TYPES = {
  mine:        { label: 'Mine / production site',  role: 'mine' },
  depot:       { label: 'Transport depot',         role: 'transporter' },
  weighbridge: { label: 'Weighbridge',             role: 'weighbridge' },
  inspection:  { label: 'Inspection yard',         role: 'inspector' },
  border:      { label: 'Border post',             role: 'border' },
  port:        { label: 'Port',                    role: 'port' },
};
const SELF_SIGNUP_ROLES = Object.values(STOP_TYPES).map((t) => t.role);

// event_type -> who may record it, which batch status it leads to, and
// which statuses it may follow (state machine for the chain of custody).
const EVENT_RULES = {
  REGISTERED:      { label: 'Registered at mine',   roles: ['mine', 'admin'],                                              status: 'registered',      from: null },
  PROCESSED:       { label: 'Processed',            roles: ['mine', 'admin'],                                              status: 'processed',       from: ['registered'] },
  EXPORT_READY:    { label: 'Declared ready for export', roles: ['mine', 'admin'],                                         status: null,              from: ['processed'] },
  WEIGHBRIDGE:     { label: 'Weighbridge reading',  roles: ['weighbridge', 'admin'],                                       status: null,              from: ['registered', 'processed', 'in_transit', 'inspected', 'export_approved', 'exported'] },
  DISPATCHED:      { label: 'Dispatched',           roles: ['mine', 'transporter', 'admin'],                               status: 'in_transit',      from: ['registered', 'processed'] },
  CHECKPOINT:      { label: 'Transit / border checkpoint', roles: ['transporter', 'weighbridge', 'inspector', 'regulator', 'border', 'port', 'admin'], status: null, from: ['in_transit', 'inspected', 'export_approved', 'exported', 'shipped'] },
  INSPECTED:       { label: 'Inspected',            roles: ['inspector', 'regulator', 'admin'],                            status: 'inspected',       from: ['registered', 'processed', 'in_transit'] },
  EXPORT_APPROVED: { label: 'Export permit issued', roles: ['regulator', 'admin'],                                         status: 'export_approved', from: ['inspected'] },
  EXPORTED:        { label: 'Exported (left Zambia)', roles: ['regulator', 'admin'],                                       status: 'exported',        from: ['export_approved'] },
  SHIPPED:         { label: 'Loaded on vessel / shipped', roles: ['port', 'admin'],                                        status: 'shipped',         from: ['exported'] },
  RECEIVED:        { label: 'Received by buyer',    roles: ['buyer', 'admin'],                                             status: 'received',        from: ['exported', 'shipped'] },
};

const EVENT_TYPES = Object.keys(EVENT_RULES);
const CLOSED_STATUSES = ['received'];

/** Roles that can see every batch (they operate along the whole chain). */
const GLOBAL_VIEW_ROLES = ['admin', 'regulator', 'inspector', 'weighbridge', 'transporter'];

/**
 * Foreign-side stops (border posts, ports) only see consignments that have left the mine
 * and are moving towards export. They cannot browse batches still being produced.
 */
const OUTBOUND_VIEW_ROLES = ['border', 'port'];
const OUTBOUND_STATUSES = ['in_transit', 'inspected', 'export_approved', 'exported', 'shipped', 'received'];

const WEIGHT_TOLERANCE = 0.02; // 2% difference vs declared weight raises a flag

module.exports = {
  ROLES, ROLE_LABELS, STOP_TYPES, SELF_SIGNUP_ROLES, EVENT_RULES, EVENT_TYPES, CLOSED_STATUSES,
  GLOBAL_VIEW_ROLES, OUTBOUND_VIEW_ROLES, OUTBOUND_STATUSES, WEIGHT_TOLERANCE,
};
