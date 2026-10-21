import { Op } from 'sequelize';
import { parseListQuery } from '../src/utils/pagination.js';

describe('parseListQuery', () => {
  const opts = { sortable: ['name', 'createdAt'], searchable: ['name', 'code'], filterable: ['status'] };

  it('applies defaults and caps the limit', () => {
    expect(parseListQuery({}, opts)).toMatchObject({
      page: 1,
      limit: 20,
      offset: 0,
      order: [['createdAt', 'DESC']],
    });
    expect(parseListQuery({ page: '3', limit: '500' }, opts)).toMatchObject({
      page: 3,
      limit: 100,
      offset: 200,
    });
  });

  it('ignores sort fields that are not whitelisted', () => {
    expect(parseListQuery({ sort: '-name,password' }, opts).order).toEqual([['name', 'DESC']]);
    expect(parseListQuery({ sort: 'password' }, opts).order).toEqual([['createdAt', 'DESC']]);
  });

  it('builds filters and an escaped search clause', () => {
    const { where } = parseListQuery({ status: 'active,draft', search: '50%_off', role: 'admin' }, opts);

    expect(where.status).toEqual({ [Op.in]: ['active', 'draft'] });
    expect(where.role).toBeUndefined();
    expect(where[Op.or]).toEqual([
      { name: { [Op.like]: '%50\\%\\_off%' } },
      { code: { [Op.like]: '%50\\%\\_off%' } },
    ]);
  });
});
