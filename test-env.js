console.log('--- Environment Check ---');
console.log('GITHUB_REPOSITORY:', process.env.GITHUB_REPOSITORY);
console.log('PORT:', process.env.PORT);
console.log('GH_TOKEN PRESENT:', !!process.env.GH_TOKEN);
if (process.env.GH_TOKEN) {
    console.log('GH_TOKEN LENGTH:', process.env.GH_TOKEN.length);
}
console.log('---------------------------');
process.exit(0);
