import Decimal from 'decimal.js';

/**
 * Amount in words for invoices, in the South Asian system (hundred, thousand, lakh, crore):
 *   amountInWords('15663.50', 'en') → "Taka Fifteen Thousand Six Hundred Sixty-Three and Fifty Paisa Only"
 *   amountInWords('15663.50', 'bn') → "পনেরো হাজার ছয়শত তেষট্টি টাকা পঞ্চাশ পয়সা মাত্র"
 */

const EN_ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const EN_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// Bangla has a distinct word for every number below 100.
const BN = [
  'শূন্য',
  'এক',
  'দুই',
  'তিন',
  'চার',
  'পাঁচ',
  'ছয়',
  'সাত',
  'আট',
  'নয়',
  'দশ',
  'এগারো',
  'বারো',
  'তেরো',
  'চৌদ্দ',
  'পনেরো',
  'ষোলো',
  'সতেরো',
  'আঠারো',
  'উনিশ',
  'বিশ',
  'একুশ',
  'বাইশ',
  'তেইশ',
  'চব্বিশ',
  'পঁচিশ',
  'ছাব্বিশ',
  'সাতাশ',
  'আটাশ',
  'ঊনত্রিশ',
  'ত্রিশ',
  'একত্রিশ',
  'বত্রিশ',
  'তেত্রিশ',
  'চৌত্রিশ',
  'পঁয়ত্রিশ',
  'ছত্রিশ',
  'সাঁইত্রিশ',
  'আটত্রিশ',
  'ঊনচল্লিশ',
  'চল্লিশ',
  'একচল্লিশ',
  'বিয়াল্লিশ',
  'তেতাল্লিশ',
  'চুয়াল্লিশ',
  'পঁয়তাল্লিশ',
  'ছেচল্লিশ',
  'সাতচল্লিশ',
  'আটচল্লিশ',
  'ঊনপঞ্চাশ',
  'পঞ্চাশ',
  'একান্ন',
  'বাহান্ন',
  'তিপ্পান্ন',
  'চুয়ান্ন',
  'পঞ্চান্ন',
  'ছাপ্পান্ন',
  'সাতান্ন',
  'আটান্ন',
  'ঊনষাট',
  'ষাট',
  'একষট্টি',
  'বাষট্টি',
  'তেষট্টি',
  'চৌষট্টি',
  'পঁয়ষট্টি',
  'ছেষট্টি',
  'সাতষট্টি',
  'আটষট্টি',
  'ঊনসত্তর',
  'সত্তর',
  'একাত্তর',
  'বাহাত্তর',
  'তিয়াত্তর',
  'চুয়াত্তর',
  'পঁচাত্তর',
  'ছিয়াত্তর',
  'সাতাত্তর',
  'আটাত্তর',
  'ঊনআশি',
  'আশি',
  'একাশি',
  'বিরাশি',
  'তিরাশি',
  'চুরাশি',
  'পঁচাশি',
  'ছিয়াশি',
  'সাতাশি',
  'আটাশি',
  'ঊননব্বই',
  'নব্বই',
  'একানব্বই',
  'বিরানব্বই',
  'তিরানব্বই',
  'চুরানব্বই',
  'পঁচানব্বই',
  'ছিয়ানব্বই',
  'সাতানব্বই',
  'আটানব্বই',
  'নিরানব্বই',
];

const en99 = (n) =>
  n < 20 ? EN_ONES[n] : `${EN_TENS[Math.floor(n / 10)]}${n % 10 ? `-${EN_ONES[n % 10]}` : ''}`;

/** Words for a whole number (0 ≤ n), split into crore / lakh / thousand / hundred / rest. */
function words(n, lang) {
  if (n === 0) return lang === 'bn' ? BN[0] : EN_ONES[0];
  const parts = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  const small = (x) => (lang === 'bn' ? BN[x] : en99(x));
  // Above 99 crore the crore count itself is spelled out recursively ("One Hundred Crore").
  if (crore)
    parts.push(`${crore < 100 ? small(crore) : words(crore, lang)} ${lang === 'bn' ? 'কোটি' : 'Crore'}`);
  if (lakh) parts.push(`${small(lakh)} ${lang === 'bn' ? 'লক্ষ' : 'Lakh'}`);
  if (thousand) parts.push(`${small(thousand)} ${lang === 'bn' ? 'হাজার' : 'Thousand'}`);
  if (hundred) parts.push(lang === 'bn' ? `${BN[hundred]}শত` : `${EN_ONES[hundred]} Hundred`);
  if (rest) parts.push(small(rest));
  return parts.join(' ');
}

export function amountInWords(amount, lang = 'en') {
  const value = new Decimal(amount ?? 0).abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const taka = value.floor().toNumber();
  const paisa = value.minus(value.floor()).times(100).round().toNumber();
  if (lang === 'bn') {
    return `${words(taka, 'bn')} টাকা${paisa ? ` ${BN[paisa]} পয়সা` : ''} মাত্র`;
  }
  return `Taka ${words(taka, 'en')}${paisa ? ` and ${en99(paisa)} Paisa` : ''} Only`;
}
