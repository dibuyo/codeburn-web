function looksLikeCodeburnReport(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    (value.overview ||
      Array.isArray(value.daily) ||
      Array.isArray(value.models) ||
      Array.isArray(value.projects) ||
      Array.isArray(value.topSessions))
  );
}

function reportFromImportBody(body = {}) {
  if (looksLikeCodeburnReport(body)) return body;
  if (looksLikeCodeburnReport(body.report)) return body.report;
  if (looksLikeCodeburnReport(body.data)) return body.data;
  if (looksLikeCodeburnReport(body.payload)) return body.payload;
  if (looksLikeCodeburnReport(body.codeburn)) return body.codeburn;
  return null;
}

function normalizeProvider(value) {
  const provider = String(value || 'all').trim().toLowerCase();
  return provider || 'all';
}

function identityFromImportBody(body = {}, report = null) {
  const identity = body.identity || body.site || body.metadata || report?.identity || report?.site || report?.metadata || {};
  return {
    ...identity,
    tenant: body.tenant || body.tenancy || body.organization || identity.tenant || identity.tenancy || identity.organization || report?.tenant || report?.tenancy || report?.organization,
    device: body.device || body.computer || body.machine || identity.device || identity.computer || identity.machine || report?.device || report?.computer || report?.machine,
    hostname: body.hostname || identity.hostname || report?.hostname,
  };
}

function importSitePayload(body = {}, deps) {
  const report = reportFromImportBody(body);
  const identityInput = identityFromImportBody(body, report);
  const hasIdentityInput = !!(identityInput.tenant || identityInput.device || identityInput.hostname);
  if (!report && !hasIdentityInput) {
    throw new Error('JSON no reconocido: pegá el contenido del archivo, no la ruta, o usá un JSON con report/data/payload o tenant/device');
  }
  const imported = deps.upsertSiteIdentity(identityInput, body.selected || {});
  let snapshotId = null;
  let importedPeriodKey = null;
  let importedProvider = null;
  let duplicateSkipped = false;

  if (report) {
    const periodKey = body.periodKey || report.periodKey || report.period_key || '30days';
    const providerName = normalizeProvider(body.provider || report.provider || 'all');
    importedPeriodKey = periodKey;
    importedProvider = providerName;
    const duplicate = deps.findDuplicateSnapshot?.(report, providerName, periodKey, imported.device.id);
    if (duplicate) {
      snapshotId = duplicate.id;
      duplicateSkipped = true;
    } else {
      deps.db.exec('BEGIN');
      try {
        snapshotId = deps.insertReport(report, providerName, periodKey, imported.device.id);
        deps.db.exec('COMMIT');
      } catch (e) {
        deps.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  return {
    ok: true,
    importedReport: !!report,
    duplicateSkipped,
    snapshotId,
    importedPeriodKey,
    importedProvider,
    ...imported,
    catalog: deps.catalog(),
  };
}

module.exports = {
  importSitePayload,
  looksLikeCodeburnReport,
  reportFromImportBody,
  normalizeProvider,
  identityFromImportBody,
};
