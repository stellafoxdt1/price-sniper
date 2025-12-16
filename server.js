const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ================= CONFIGURAÇÕES =================
const SENHA_SECRETA = process.env.ADMIN_PASSWORD || "flavio123";
const DB_FILE = path.join(__dirname, 'produtos.json');
const PORT = process.env.PORT || 3000;

// ================= BANCO LOCAL =================
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

// ================= ROTAS PÁGINAS =================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ================= MIDDLEWARE ADMIN =================
const verificarSenha = (req, res, next) => {
    const senhaRecebida = req.headers['x-admin-senha'];
    if (senhaRecebida === SENHA_SECRETA) {
        next();
    } else {
        res.status(401).json({ error: 'Senha incorreta.' });
    }
};

// ================= CONTADOR DE CLIQUES =================
app.post('/products/:id/click', (req, res) => {
    try {
        const { id } = req.params;
        const data = JSON.parse(fs.readFileSync(DB_FILE));

        const index = data.findIndex(p => p.id == id);
        if (index === -1) {
            return res.status(404).json({ error: 'Produto não encontrado' });
        }

        data[index].clicks = (data[index].clicks || 0) + 1;
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

        console.log(`---> POPULARIDADE: Produto ${id} recebeu clique (${data[index].clicks})`);
        res.json({ success: true, clicks: data[index].clicks });

    } catch (err) {
        console.error("Erro ao registrar clique:", err);
        res.status(500).json({ error: 'Erro no servidor' });
    }
});

// ================= SCRAPING =================
app.get('/scrape', async (req, res) => {
    const { url, category } = req.query;
    if (!url) return res.status(400).json({ error: 'URL necessária' });

    const categoriaFinal = category || "Geral";
    console.log(`---> ALVO: ${url} | CATEGORIA: ${categoriaFinal}`);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
        );

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        try {
            await page.waitForSelector('.andes-money-amount', { timeout: 5000 });
        } catch {}

        const productData = await page.evaluate(() => {
            const title =
                document.querySelector('h1.ui-pdp-title')?.innerText ||
                document.title;

            let price = null;

            const metaPrice = document.querySelector('meta[itemprop="price"]');
            if (metaPrice?.content) {
                price = parseFloat(metaPrice.content);
            }

            if (!price) {
                const prices = [];
                document.querySelectorAll('.andes-money-amount').forEach(el => {
                    const isStrike = el.closest('s') || el.closest('.andes-money-amount--previous');
                    const parentText = el.parentElement?.innerText.toLowerCase() || '';
                    const isInstallment = parentText.includes('x');

                    if (!isStrike && !isInstallment) {
                        const frac = el.querySelector('.andes-money-amount__fraction')?.innerText.replace(/\./g, '');
                        const cents = el.querySelector('.andes-money-amount__cents')?.innerText || '00';
                        if (frac) {
                            const val = parseFloat(`${frac}.${cents}`);
                            if (val > 10) prices.push(val);
                        }
                    }
                });
                if (prices.length) price = Math.min(...prices);
            }

            const image =
                document.querySelector('meta[property="og:image"]')?.content ||
                document.querySelector('img.ui-pdp-image')?.src ||
                null;

            return { title, price, thumbnail: image };
        });

        if (!productData.title || !productData.price) {
            throw new Error("Dados incompletos");
        }

        res.json({
            title: productData.title,
            price: productData.price,
            category: categoriaFinal,
            thumbnail: productData.thumbnail,
            link: url
        });

    } catch (err) {
        console.error("Erro Puppeteer:", err.message);
        res.status(500).json({ error: 'Erro ao processar. Use modo manual.' });
    } finally {
        if (browser) await browser.close();
    }
});

// ================= CRUD PRODUTOS =================
app.get('/products', (req, res) => {
    try {
        res.json(JSON.parse(fs.readFileSync(DB_FILE)));
    } catch {
        res.json([]);
    }
});

app.post('/products', verificarSenha, (req, res) => {
    try {
        const data = fs.existsSync(DB_FILE)
            ? JSON.parse(fs.readFileSync(DB_FILE))
            : [];

        const newProduct = {
            id: Date.now(),
            clicks: 0,
            ...req.body
        };

        data.unshift(newProduct);
        if (data.length > 200) data.pop();

        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
        res.json(newProduct);

    } catch {
        res.status(500).json({ error: 'Erro ao gravar produto' });
    }
});

app.delete('/products/:id', verificarSenha, (req, res) => {
    const { id } = req.params;
    const data = JSON.parse(fs.readFileSync(DB_FILE)).filter(p => p.id != id);
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
});

// ================= START SERVER =================
app.listen(PORT, () => {
    console.log(`Servidor V10 rodando na porta ${PORT}`);
});
