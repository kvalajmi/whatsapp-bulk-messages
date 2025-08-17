const XLSX = require('./server/node_modules/xlsx');

// Sample data with Arabic/English headers as specified
const data = [
  // Headers row
  ['Customer Name', 'National ID', 'Phone Number', 'Phone Number 2', 'Phone Number 3', 'Amount Due', 'Message Text'],
  // Data rows
  ['أحمد محمد', '123456789', '+96512345678', '+96587654321', '', 500.00, 'مرحبا {name}، المبلغ المستحق هو {amountDue} دينار'],
  ['فاطمة علي', '987654321', '+96598765432', '', '', 750.50, 'عزيزي {name}، يرجى سداد مبلغ {amountDue} دينار'],
  ['محمد حسن', '456789123', '+96545678912', '+96512398765', '+96567891234', 1200.00, 'السلام عليكم {name}، المطلوب سداد {amountDue} دينار'],
  ['سارة أحمد', '789123456', '+96578912345', '', '', 300.25, 'مرحبا {name}، لديك مستحقات بقيمة {amountDue} دينار'],
  ['علي محمود', '321654987', '+96532165498', '+96598765123', '', 950.75, 'عزيزي العميل {name}، المبلغ المطلوب {amountDue} دينار']
];

// Create workbook and worksheet
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet(data);

// Add worksheet to workbook
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

// Write file
XLSX.writeFile(wb, 'sample-data.xlsx');

console.log('Excel file created successfully!');
console.log('File: sample-data.xlsx');
console.log('Rows:', data.length - 1, 'customers');
console.log('Headers:', data[0].join(' | '));
