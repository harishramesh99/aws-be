const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { CloudWatch } = require('@aws-sdk/client-cloudwatch');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// AWS S3 setup
// AWS S3 setup

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// CloudWatch setup
const cloudwatch = new CloudWatch({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// MySQL setup
const pool = mysql.createPool({
  host: process.env.RDS_HOSTNAME,
  user: process.env.RDS_USERNAME,
  password: process.env.RDS_PASSWORD,
  database: process.env.RDS_DB_NAME,
});

// Add this at the start of your server
pool.getConnection()
  .then(connection => {
    console.log('Database connected successfully');
    connection.release();
  })
  .catch(err => {
    console.error('Error connecting to the database:', err);
  });

  pool.query('SHOW DATABASES')
    .then(([rows]) => {
        console.log('Available databases:', rows);
    })
    .catch(err => {
        console.error('Database error:', err);
    });

    pool.query('SHOW TABLES FROM contact_system')
    .then(([rows]) => {
        console.log('Tables in contact_system:', rows);
    })
    .catch(err => {
        console.error('Error checking tables:', err);
    });

// Also check if there are any records
pool.query('SELECT * FROM contact_system.submissions')
    .then(([rows]) => {
        console.log('Number of submissions:', rows.length);
    })
    .catch(err => {
        console.error('Error querying submissions:', err);
    });

// Multer setup for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});



// Monitoring middleware
app.use(async (_req, res, next) => {
  const start = Date.now();

  res.on('finish', async () => {
    try {
      const duration = Date.now() - start;
      await cloudwatch.putMetricData({
        MetricData: [
          {
            MetricName: 'RequestDuration',
            Value: duration,
            Unit: 'Milliseconds',
            Dimensions: [
              {
                Name: 'Endpoint',
                Value: req.path
              }
            ]
          },
          {
            MetricName: 'RequestCount',
            Value: 1,
            Unit: 'Count',
            Dimensions: [
              {
                Name: 'Endpoint',
                Value: req.path
              }
            ]
          }
        ],
        Namespace: 'ContactFormAPI'
      });
    } catch (error) {
      console.error('CloudWatch Metric Error:', error);
    }
  });

  next();
});



// Global error handler
app.use((err, _req, res, next) => {
  console.error(err);
  cloudwatch.putMetricData({
    MetricData: [
      {
        MetricName: 'Errors',
        Value: 1,
        Unit: 'Count',
        Dimensions: [
          {
            Name: 'ErrorType',
            Value: err.name || 'UnknownError'
          }
        ]
      }
    ],
    Namespace: 'ContactFormAPI'
  }).catch(console.error);
  
  res.status(500).json({ error: 'Internal Server Error' });
});
app.get('/', (_req, res) => {
  res.send('Welcome to the Contact System API!');
});

// Routes
app.post('/api/contact', upload.single('image'), async (_req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required.' });
    }

    let imageUrl = null;
    if (req.file) {
      const fileKey = `contacts/${Date.now()}-${req.file.originalname}`;
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: fileKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));
      imageUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileKey}`;
    }

    const [result] = await pool.execute(
      'INSERT INTO submissions (name, email, message, image_url) VALUES (?, ?, ?, ?)',
      [name, email, message, imageUrl]
    );

    res.json({ success: true, id: result.insertId, imageUrl });
  } catch (error) {
    console.error('Error:', error);
    await cloudwatch.putMetricData({
      MetricData: [
        {
          MetricName: 'Errors',
          Value: 1,
          Unit: 'Count',
          Dimensions: [
            {
              Name: 'ErrorType',
              Value: 'ContactSubmissionError'
            }
          ]
        }
      ],
      Namespace: 'ContactFormAPI'
    }).catch(console.error);
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/submissions', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM submissions ORDER BY created_at DESC');
    res.json(rows); // Correctly send the rows as the response
  } catch (error) {
    await cloudwatch.putMetricData({
      MetricData: [
        {
          MetricName: 'Errors',
          Value: 1,
          Unit: 'Count',
          Dimensions: [
            {
              Name: 'ErrorType',
              Value: 'FetchSubmissionsError'
            }
          ]
        }
      ],
      Namespace: 'ContactFormAPI'
    }).catch(console.error);
    res.status(500).json({ error: error.message });
  }
});



const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});