import { describe, expect, it } from 'vitest';
import { createOdataRoutes } from './odata-url.js';

const routes = createOdataRoutes('https://tenant.ivanti.com', '/HEAT');
const bare = createOdataRoutes('https://tenant.ivanti.com', '');

describe('createOdataRoutes', () => {
  it('builds an entity-set URL under the base path', () => {
    expect(routes.entitySet('Incidents')).toBe(
      'https://tenant.ivanti.com/HEAT/api/odata/businessobject/Incidents',
    );
  });

  it('works without the /HEAT prefix', () => {
    expect(bare.entitySet('Incidents')).toBe(
      'https://tenant.ivanti.com/api/odata/businessobject/Incidents',
    );
  });

  it('quotes the record key the way Ivanti expects', () => {
    expect(routes.record('Incidents', 'ABC123')).toMatch(/Incidents\('ABC123'\)$/);
  });

  it('encodes a key rather than letting a quote break out of it', () => {
    expect(routes.record('Incidents', "a'b")).toContain("('a%27b')");
  });

  it('builds relationship and $Ref URLs', () => {
    expect(routes.related('Incidents', 'A', 'IncidentContainsTask')).toMatch(
      /Incidents\('A'\)\/IncidentContainsTask$/,
    );
    expect(routes.ref('Incidents', 'A', 'IncidentContainsTask', 'B')).toMatch(
      /Incidents\('A'\)\/IncidentContainsTask\('B'\)\/\$Ref$/,
    );
  });

  it('builds metadata URLs for a graph and for the service root', () => {
    expect(routes.metadata('incidents')).toBe(
      'https://tenant.ivanti.com/HEAT/api/odata/incidents/$metadata',
    );
    expect(routes.metadata()).toBe(
      'https://tenant.ivanti.com/HEAT/api/odata/$metadata',
    );
  });

  it('tolerates a trailing slash on the configured base URL', () => {
    expect(createOdataRoutes('https://t.example/', '/HEAT').entitySet('X')).toBe(
      'https://t.example/HEAT/api/odata/businessobject/X',
    );
  });
});
