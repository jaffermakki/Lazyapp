const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { RateLimiterMemory } = require('rate-limiter-flexible');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.ip,
  points: 10, // 10 requests
  duration: 60, // per 60 seconds
});

app.use((req, res, next) => {
  rateLimiter.consume(req.ip)
    .then(() => next())
    .catch(() => res.status(429).json({ error: 'Too many requests' }));
});

// API Keys (in production, use environment variables)
const API_KEYS = {
  adzuna: {
    appId: process.env.ADZUNA_APP_ID || 'your_adzuna_app_id',
    appKey: process.env.ADZUNA_APP_KEY || 'your_adzuna_app_key'
  },
  reed: process.env.REED_API_KEY || 'your_reed_api_key',
  usajobs: process.env.USAJOBS_API_KEY || 'your_usajobs_api_key'
};

// Job Search Endpoints

// Adzuna API - Global job search
app.get('/api/jobs/adzuna', async (req, res) => {
  try {
    const { keywords = 'software engineer', location = 'london', page = 1, resultsPerPage = 20 } = req.query;
    
    const response = await axios.get(`https://api.adzuna.com/v1/api/jobs/gb/search/${page}`, {
      params: {
        app_id: API_KEYS.adzuna.appId,
        app_key: API_KEYS.adzuna.appKey,
        what: keywords,
        where: location,
        results_per_page: resultsPerPage,
        content_type: 'application/json'
      }
    });

    const jobs = response.data.results.map(job => ({
      id: job.id,
      title: job.title,
      company: job.company?.display_name || 'Unknown Company',
      location: job.location?.display_name || 'Location not specified',
      salary: job.salary_min || job.salary_max ? 
        `£${job.salary_min || ''} - £${job.salary_max || ''}` : 'Salary not specified',
      description: job.description,
      url: job.redirect_url,
      posted: new Date(job.created).toLocaleDateString(),
      source: 'Adzuna'
    }));

    res.json({
      success: true,
      jobs,
      total: response.data.count
    });
  } catch (error) {
    console.error('Adzuna API error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch jobs from Adzuna',
      jobs: getFallbackJobs(req.query.keywords, req.query.location, 'Adzuna')
    });
  }
});

// Reed API - UK jobs
app.get('/api/jobs/reed', async (req, res) => {
  try {
    const { keywords = 'software engineer', location = 'london' } = req.query;
    
    const response = await axios.get('https://www.reed.co.uk/api/1.0/search', {
      params: {
        keywords,
        location
      },
      headers: {
        'Authorization': `Basic ${Buffer.from(API_KEYS.reed + ':').toString('base64')}`
      }
    });

    const jobs = response.data.results.map(job => ({
      id: job.jobId,
      title: job.jobTitle,
      company: job.employerName,
      location: job.locationName,
      salary: job.minimumSalary || job.maximumSalary ? 
        `£${job.minimumSalary || ''} - £${job.maximumSalary || ''}` : 'Salary not specified',
      description: job.jobDescription,
      url: job.jobUrl,
      posted: new Date(job.date).toLocaleDateString(),
      source: 'Reed'
    }));

    res.json({
      success: true,
      jobs,
      total: response.data.totalResults
    });
  } catch (error) {
    console.error('Reed API error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch jobs from Reed',
      jobs: getFallbackJobs(req.query.keywords, req.query.location, 'Reed')
    });
  }
});

// USAJobs API - US government jobs
app.get('/api/jobs/usajobs', async (req, res) => {
  try {
    const { keywords = 'software', location = 'washington dc' } = req.query;
    
    const response = await axios.get('https://data.usajobs.gov/api/search', {
      headers: {
        'Authorization-Key': API_KEYS.usajobs,
        'User-Agent': 'JobSearchApp/1.0'
      },
      params: {
        Keyword: keywords,
        LocationName: location
      }
    });

    const jobs = response.data.SearchResult.SearchResultItems.map(item => {
      const job = item.MatchedObjectDescriptor;
      return {
        id: job.MatchedObjectId,
        title: job.PositionTitle,
        company: job.OrganizationName,
        location: job.PositionLocationDisplay,
        salary: job.PositionRemuneration?.[0]?.MinimumRange || job.PositionRemuneration?.[0]?.MaximumRange ?
          `$${job.PositionRemuneration[0].MinimumRange || ''} - $${job.PositionRemuneration[0].MaximumRange || ''}` : 'Salary not specified',
        description: job.UserArea.Details.JobSummary,
        url: job.ApplyURI?.[0] || job.PositionURI,
        posted: new Date(job.PositionStartDate).toLocaleDateString(),
        source: 'USAJobs'
      };
    });

    res.json({
      success: true,
      jobs,
      total: response.data.SearchResult.SearchResultCount
    });
  } catch (error) {
    console.error('USAJobs API error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch jobs from USAJobs',
      jobs: getFallbackJobs(req.query.keywords, req.query.location, 'USAJobs')
    });
  }
});

// Combined search endpoint
app.get('/api/jobs/search', async (req, res) => {
  try {
    const { keywords, location, sources = 'adzuna,reed,usajobs' } = req.query;
    const sourceList = sources.split(',');
    
    const promises = [];
    
    if (sourceList.includes('adzuna')) {
      promises.push(
        axios.get(`${req.protocol}://${req.get('host')}/api/jobs/adzuna`, {
          params: { keywords, location }
        }).catch(error => ({ data: { success: false, jobs: [] } }))
      );
    }
    
    if (sourceList.includes('reed')) {
      promises.push(
        axios.get(`${req.protocol}://${req.get('host')}/api/jobs/reed`, {
          params: { keywords, location }
        }).catch(error => ({ data: { success: false, jobs: [] } }))
      );
    }
    
    if (sourceList.includes('usajobs')) {
      promises.push(
        axios.get(`${req.protocol}://${req.get('host')}/api/jobs/usajobs`, {
          params: { keywords, location }
        }).catch(error => ({ data: { success: false, jobs: [] } }))
      );
    }

    const results = await Promise.all(promises);
    const allJobs = results.flatMap(result => result.data.jobs || []);
    
    // Remove duplicates based on title and company
    const uniqueJobs = allJobs.filter((job, index, self) =>
      index === self.findIndex(j => j.title === job.title && j.company === job.company)
    );

    res.json({
      success: true,
      jobs: uniqueJobs,
      total: uniqueJobs.length,
      sources: sourceList
    });
  } catch (error) {
    console.error('Combined search error:', error);
    res.status(500).json({
      success: false,
      error: 'Search failed',
      jobs: getFallbackJobs(keywords, location, 'Multiple Sources')
    });
  }
});

// Fallback job data
function getFallbackJobs(keywords, location, source) {
  const baseJobs = [
    {
      id: `1-${Date.now()}`,
      title: `${keywords || 'Software'} Developer`,
      company: 'Tech Innovations Inc.',
      location: location || 'Remote',
      salary: '$80,000 - $120,000',
      description: `We are looking for a skilled ${keywords || 'software'} developer to join our growing team.`,
      url: `https://www.example.com/jobs/${encodeURIComponent(keywords || 'software')}-developer`,
      posted: new Date().toLocaleDateString(),
      source: source || 'Fallback'
    },
    {
      id: `2-${Date.now()}`,
      title: `Senior ${keywords || 'Software'} Engineer`,
      company: 'Digital Solutions Ltd.',
      location: location || 'New York, NY',
      salary: '$120,000 - $160,000',
      description: `Senior ${keywords || 'software'} position with leadership responsibilities.`,
      url: `https://www.example.com/jobs/senior-${encodeURIComponent(keywords || 'software')}`,
      posted: new Date(Date.now() - 86400000).toLocaleDateString(), // 1 day ago
      source: source || 'Fallback'
    },
    {
      id: `3-${Date.now()}`,
      title: `${keywords || 'Software'} Specialist`,
      company: 'Tech Corp',
      location: location || 'San Francisco, CA',
      salary: '$90,000 - $130,000',
      description: `Join our team as a ${keywords || 'software'} specialist.`,
      url: `https://www.example.com/jobs/${encodeURIComponent(keywords || 'software')}-specialist`,
      posted: new Date(Date.now() - 172800000).toLocaleDateString(), // 2 days ago
      source: source || 'Fallback'
    }
  ];
  
  return baseJobs;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    services: {
      adzuna: !!API_KEYS.adzuna.appId,
      reed: !!API_KEYS.reed,
      usajobs: !!API_KEYS.usajobs
    }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});