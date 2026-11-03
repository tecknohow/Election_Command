export interface StateInfo {
  postal: string;
  name: string;
  fips: string;
}

export const STATES: StateInfo[] = [
  { postal: 'AL', name: 'Alabama', fips: '01' },
  { postal: 'AK', name: 'Alaska', fips: '02' },
  { postal: 'AZ', name: 'Arizona', fips: '04' },
  { postal: 'AR', name: 'Arkansas', fips: '05' },
  { postal: 'CA', name: 'California', fips: '06' },
  { postal: 'CO', name: 'Colorado', fips: '08' },
  { postal: 'CT', name: 'Connecticut', fips: '09' },
  { postal: 'DE', name: 'Delaware', fips: '10' },
  { postal: 'DC', name: 'District of Columbia', fips: '11' },
  { postal: 'FL', name: 'Florida', fips: '12' },
  { postal: 'GA', name: 'Georgia', fips: '13' },
  { postal: 'HI', name: 'Hawaii', fips: '15' },
  { postal: 'ID', name: 'Idaho', fips: '16' },
  { postal: 'IL', name: 'Illinois', fips: '17' },
  { postal: 'IN', name: 'Indiana', fips: '18' },
  { postal: 'IA', name: 'Iowa', fips: '19' },
  { postal: 'KS', name: 'Kansas', fips: '20' },
  { postal: 'KY', name: 'Kentucky', fips: '21' },
  { postal: 'LA', name: 'Louisiana', fips: '22' },
  { postal: 'ME', name: 'Maine', fips: '23' },
  { postal: 'MD', name: 'Maryland', fips: '24' },
  { postal: 'MA', name: 'Massachusetts', fips: '25' },
  { postal: 'MI', name: 'Michigan', fips: '26' },
  { postal: 'MN', name: 'Minnesota', fips: '27' },
  { postal: 'MS', name: 'Mississippi', fips: '28' },
  { postal: 'MO', name: 'Missouri', fips: '29' },
  { postal: 'MT', name: 'Montana', fips: '30' },
  { postal: 'NE', name: 'Nebraska', fips: '31' },
  { postal: 'NV', name: 'Nevada', fips: '32' },
  { postal: 'NH', name: 'New Hampshire', fips: '33' },
  { postal: 'NJ', name: 'New Jersey', fips: '34' },
  { postal: 'NM', name: 'New Mexico', fips: '35' },
  { postal: 'NY', name: 'New York', fips: '36' },
  { postal: 'NC', name: 'North Carolina', fips: '37' },
  { postal: 'ND', name: 'North Dakota', fips: '38' },
  { postal: 'OH', name: 'Ohio', fips: '39' },
  { postal: 'OK', name: 'Oklahoma', fips: '40' },
  { postal: 'OR', name: 'Oregon', fips: '41' },
  { postal: 'PA', name: 'Pennsylvania', fips: '42' },
  { postal: 'RI', name: 'Rhode Island', fips: '44' },
  { postal: 'SC', name: 'South Carolina', fips: '45' },
  { postal: 'SD', name: 'South Dakota', fips: '46' },
  { postal: 'TN', name: 'Tennessee', fips: '47' },
  { postal: 'TX', name: 'Texas', fips: '48' },
  { postal: 'UT', name: 'Utah', fips: '49' },
  { postal: 'VT', name: 'Vermont', fips: '50' },
  { postal: 'VA', name: 'Virginia', fips: '51' },
  { postal: 'WA', name: 'Washington', fips: '53' },
  { postal: 'WV', name: 'West Virginia', fips: '54' },
  { postal: 'WI', name: 'Wisconsin', fips: '55' },
  { postal: 'WY', name: 'Wyoming', fips: '56' },
];

export const STATE_BY_POSTAL: Record<string, StateInfo> = Object.fromEntries(STATES.map((s) => [s.postal, s]));
export const STATE_BY_FIPS: Record<string, StateInfo> = Object.fromEntries(STATES.map((s) => [s.fips, s]));
export const STATE_BY_NAME: Record<string, StateInfo> = Object.fromEntries(STATES.map((s) => [s.name.toLowerCase(), s]));

export const OFFICE_LABEL: Record<string, string> = {
  S: 'U.S. Senate',
  G: 'Governor',
  H: 'U.S. House',
};

export function raceId(state: string, office: string, district?: number | null): string {
  return office === 'H' ? `${state}-H-${district ?? 0}` : `${state}-${office}`;
}
