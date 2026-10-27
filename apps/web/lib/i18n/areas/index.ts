// Strings of feature areas, each in its own file (areas/<id>.ts exporting `en` and `ar`) so that
// parallel work does not collide in en.ts / ar.ts. Every area is reachable as t.<camelCaseId>.
import * as accountSecurity from './account-security';
import * as adminWorkflows from './admin-workflows';
import * as approvalChains from './approval-chains';
import * as employeeHub from './employee-hub';
import * as employeeSelfService from './employee-self-service';
import * as mascotAdmin from './mascot-admin';
import * as navFindability from './nav-findability';
import * as portalVisibility from './portal-visibility';
import * as uiFoundation from './ui-foundation';

export const areasEn = {
  portalVisibility: portalVisibility.en,
  employeeHub: employeeHub.en,
  navFindability: navFindability.en,
  adminWorkflows: adminWorkflows.en,
  employeeSelfService: employeeSelfService.en,
  uiFoundation: uiFoundation.en,
  mascotAdmin: mascotAdmin.en,
  accountSecurity: accountSecurity.en,
  approvalChains: approvalChains.en,
};

export const areasAr: typeof areasEn = {
  portalVisibility: portalVisibility.ar,
  employeeHub: employeeHub.ar,
  navFindability: navFindability.ar,
  adminWorkflows: adminWorkflows.ar,
  employeeSelfService: employeeSelfService.ar,
  uiFoundation: uiFoundation.ar,
  mascotAdmin: mascotAdmin.ar,
  accountSecurity: accountSecurity.ar,
  approvalChains: approvalChains.ar,
};
